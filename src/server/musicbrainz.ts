import { CACHE_TTL_MS, USER_AGENT } from './config.js';
import { cacheGet, cacheSet } from './db.js';
import { SpacedQueue, UpstreamError, fetchJson, isAbortError, sleep } from './http.js';
import { pickPreferredRelease } from './editions.js';
import { escapeLucenePhrase, fuzzyLuceneTerms } from './text.js';
import type { Edition, EditionMedium, EditionsResponse } from '../shared/types.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';

/** MusicBrainz allows ~1 request/second per client. */
const queue = new SpacedQueue(1100);
const inflight = new Map<string, Promise<unknown>>();

export const PRIORITY_INTERACTIVE = 10;

export interface MbRequestOptions {
  signal?: AbortSignal;
  priority?: number;
}

export interface MbArtist {
  id: string;
  name: string;
  'sort-name'?: string;
  disambiguation?: string;
  country?: string;
  type?: string;
  score?: number;
}

export interface MbArtistCredit {
  name: string;
  joinphrase?: string;
  artist: { id: string; name: string; 'sort-name'?: string; disambiguation?: string };
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  disambiguation?: string;
  rating?: { value: number | null; 'votes-count': number };
  score?: number;
  'artist-credit'?: MbArtistCredit[];
}

interface MbRelease {
  id: string;
  title: string;
  status?: string | null;
  date?: string;
  country?: string | null;
  disambiguation?: string;
  'release-events'?: { date?: string; area?: { name?: string; 'iso-3166-1-codes'?: string[] } | null }[];
  media?: {
    position: number;
    format?: string | null;
    title?: string;
    'track-count'?: number;
    tracks?: { number: string; title: string; length: number | null; position: number }[];
  }[];
}

async function mbGet<T>(pathAndQuery: string, opts: MbRequestOptions = {}): Promise<T> {
  const url = `${MB_BASE}${pathAndQuery}`;
  const cached = cacheGet<T>(url);
  if (cached !== undefined) return cached;

  const existing = inflight.get(url) as Promise<T> | undefined;
  if (existing) {
    try {
      return await existing;
    } catch (err) {
      // The original requester aborted; retry on our own behalf.
      if (isAbortError(err) && !opts.signal?.aborted) return mbGet<T>(pathAndQuery, opts);
      throw err;
    }
  }

  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await queue.run(
          () =>
            fetchJson<T>(url, {
              service: 'MusicBrainz',
              headers: { 'User-Agent': USER_AGENT },
              timeoutMs: 20000,
              signal: opts.signal,
            }),
          { priority: opts.priority ?? 0, signal: opts.signal },
        );
        cacheSet(url, data, CACHE_TTL_MS);
        return data;
      } catch (err) {
        // Network failures/timeouts (no upstream status), rate limiting and 5xx are transient.
        const retryable =
          err instanceof UpstreamError &&
          (err.upstreamStatus === null || err.upstreamStatus === 429 || err.upstreamStatus >= 500);
        if (attempt < 2 && retryable && !opts.signal?.aborted) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  })();
  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(url);
  }
}

/**
 * Exact-phrase artist search over names AND aliases ("blink 182" → blink‐182, "ac dc" → AC/DC, instead of
 * a tribute act), with a typo-tolerant fuzzy fallback ("good charlote" → Good Charlotte).
 */
export async function searchArtists(query: string, opts: MbRequestOptions = {}): Promise<MbArtist[]> {
  const phrase = escapeLucenePhrase(query);
  const q = `artist:"${phrase}" OR alias:"${phrase}"`;
  const data = await mbGet<{ artists?: MbArtist[] }>(`/artist?query=${encodeURIComponent(q)}&fmt=json&limit=5`, opts);
  const exact = data?.artists ?? [];
  if (exact.some((a) => (a.score ?? 0) >= 90)) return exact;
  const terms = fuzzyLuceneTerms(query);
  if (!terms) return exact;
  const fuzzy = await mbGet<{ artists?: MbArtist[] }>(
    `/artist?query=${encodeURIComponent(`artist:(${terms})`)}&fmt=json&limit=5`,
    opts,
  );
  const merged = new Map<string, MbArtist>();
  for (const a of [...exact, ...(fuzzy?.artists ?? [])]) if (!merged.has(a.id)) merged.set(a.id, a);
  return [...merged.values()];
}

export async function getArtist(mbid: string, opts: MbRequestOptions = {}): Promise<MbArtist> {
  return mbGet<MbArtist>(`/artist/${encodeURIComponent(mbid)}?fmt=json`, opts);
}

export interface MbArtistDetails extends MbArtist {
  'life-span'?: { begin?: string | null; end?: string | null; ended?: boolean | null };
  area?: { name?: string } | null;
  'begin-area'?: { name?: string } | null;
  genres?: { name: string; count: number }[];
  tags?: { name: string; count: number }[];
  rating?: { value: number | null; 'votes-count': number };
  relations?: { type: string; url?: { resource: string } }[];
}

/** Artist page: profile, genres, community rating and external links (Wikipedia/Wikidata, homepage…). */
export async function getArtistDetails(mbid: string, opts: MbRequestOptions = {}): Promise<MbArtistDetails> {
  return mbGet<MbArtistDetails>(`/artist/${encodeURIComponent(mbid)}?inc=url-rels+genres+tags+ratings&fmt=json`, {
    priority: PRIORITY_INTERACTIVE,
    ...opts,
  });
}

interface BrowseResponse {
  'release-group-count'?: number;
  'release-groups'?: MbReleaseGroup[];
}

/** Full discography (release groups + ratings). Paginates album/EP types for prolific artists. */
export async function browseReleaseGroups(artistMbid: string, opts: MbRequestOptions = {}): Promise<MbReleaseGroup[]> {
  const id = encodeURIComponent(artistMbid);
  const first = await mbGet<BrowseResponse>(`/release-group?artist=${id}&inc=ratings&limit=100&fmt=json`, opts);
  const byId = new Map<string, MbReleaseGroup>();
  for (const rg of first?.['release-groups'] ?? []) byId.set(rg.id, rg);
  const total = first?.['release-group-count'] ?? 0;

  if (total > 100) {
    // Singles usually dominate large counts: make sure every album/EP is present.
    const typeFilter = encodeURIComponent('album|ep');
    for (let offset = 0, page = 0; page < 5; page++, offset += 100) {
      const data = await mbGet<BrowseResponse>(
        `/release-group?artist=${id}&type=${typeFilter}&inc=ratings&limit=100&offset=${offset}&fmt=json`,
        opts,
      );
      const groups = data?.['release-groups'] ?? [];
      for (const rg of groups) byId.set(rg.id, rg);
      if (groups.length < 100 || offset + 100 >= (data?.['release-group-count'] ?? 0)) break;
    }
  }
  return [...byId.values()];
}

/** Targeted "Artist - Album" lookup with a fuzzy fallback for near-miss titles. */
export async function searchReleaseGroups(
  artist: string,
  album: string,
  opts: MbRequestOptions = {},
): Promise<MbReleaseGroup[]> {
  const exact = `artist:"${escapeLucenePhrase(artist)}" AND releasegroup:"${escapeLucenePhrase(album)}"`;
  const data = await mbGet<{ 'release-groups'?: MbReleaseGroup[] }>(
    `/release-group?query=${encodeURIComponent(exact)}&inc=ratings&fmt=json&limit=10`,
    opts,
  );
  const results = data?.['release-groups'] ?? [];
  if (results.some((rg) => (rg.score ?? 0) >= 70)) return results;

  // Typo-tolerant fallback: unquoted terms with fuzzy matching on longer words.
  const artistTerms = fuzzyLuceneTerms(artist);
  const albumTerms = fuzzyLuceneTerms(album);
  if (!artistTerms || !albumTerms) return results;
  const fuzzy = `artist:(${artistTerms}) AND releasegroup:(${albumTerms})`;
  const fallback = await mbGet<{ 'release-groups'?: MbReleaseGroup[] }>(
    `/release-group?query=${encodeURIComponent(fuzzy)}&inc=ratings&fmt=json&limit=10`,
    opts,
  );
  const merged = new Map<string, MbReleaseGroup>();
  for (const rg of [...results, ...(fallback?.['release-groups'] ?? [])]) if (!merged.has(rg.id)) merged.set(rg.id, rg);
  return [...merged.values()];
}

/** Album search scoped to one artist (by MBID): robust to typos and odd artist spellings ("blink‐182"). */
export async function searchReleaseGroupsByArtist(
  artistMbid: string,
  album: string,
  opts: MbRequestOptions = {},
): Promise<MbReleaseGroup[]> {
  const albumTerms = fuzzyLuceneTerms(album);
  if (!albumTerms) return [];
  const q = `arid:${artistMbid} AND releasegroup:(${albumTerms})`;
  const data = await mbGet<{ 'release-groups'?: MbReleaseGroup[] }>(
    `/release-group?query=${encodeURIComponent(q)}&inc=ratings&fmt=json&limit=25`,
    opts,
  );
  return data?.['release-groups'] ?? [];
}

function formatLabel(formats: (string | null | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const f of formats) {
    const name = (f || 'Unknown').replace('Digital Media', 'Digital').replace(/^12" Vinyl$/, 'Vinyl');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${n}×${name}` : name)).join(' + ') || 'Unknown';
}

/** Lazily loaded pressings + tracklists for the Editions drawer, with the preferred standard edition. */
export async function getReleaseGroupEditions(
  rgMbid: string,
  preferredCountry: string,
  opts: MbRequestOptions = {},
): Promise<EditionsResponse> {
  // MusicBrainz caps browse pages that include tracklists, so popular albums need several pages.
  const releases: MbRelease[] = [];
  let total = 0;
  for (let page = 0; page < 5; page++) {
    const data = await mbGet<{ releases?: MbRelease[]; 'release-count'?: number }>(
      `/release?release-group=${encodeURIComponent(rgMbid)}&inc=recordings&fmt=json&limit=100&offset=${releases.length}`,
      { priority: PRIORITY_INTERACTIVE, ...opts },
    );
    const batch = data?.releases ?? [];
    total = data?.['release-count'] ?? total;
    releases.push(...batch);
    if (batch.length === 0 || releases.length >= total) break;
  }
  const editions: Edition[] = releases.map((r) => {
    const countries = [
      ...new Set(
        [r.country, ...(r['release-events'] ?? []).flatMap((e) => e.area?.['iso-3166-1-codes'] ?? [])].filter(
          (c): c is string => Boolean(c),
        ),
      ),
    ];
    const media: EditionMedium[] = (r.media ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        position: m.position,
        format: m.format ?? null,
        title: m.title || null,
        tracks: (m.tracks ?? [])
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((t) => ({ number: t.number, title: t.title, lengthMs: t.length ?? null })),
      }));
    const trackCount = media.reduce((sum, m) => sum + m.tracks.length, 0);
    return {
      mbid: r.id,
      title: r.title,
      disambiguation: r.disambiguation || null,
      date: r.date || null,
      country: r.country || null,
      countries,
      status: r.status || null,
      format: formatLabel((r.media ?? []).map((m) => m.format)),
      trackCount,
      media,
    };
  });
  editions.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
  const preferred = pickPreferredRelease(
    editions.map((e) => ({
      key: e.mbid,
      title: e.title,
      disambiguation: e.disambiguation,
      status: e.status,
      countries: e.countries,
      formats: e.media.map((m) => m.format ?? ''),
      trackCount: e.trackCount,
      mediumCount: e.media.length,
      date: e.date,
    })),
    preferredCountry,
  );
  return {
    editions,
    preferredMbid: preferred?.key ?? null,
    preferredLabel: preferred?.label ?? null,
    totalReleases: Math.max(total, editions.length),
  };
}
