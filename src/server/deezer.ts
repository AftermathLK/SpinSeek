import { CACHE_TTL_MS } from './config.js';
import { cacheGet, cacheSet } from './db.js';
import { ApiError, SpacedQueue, UpstreamError, fetchJson, sleep } from './http.js';
import { namesMatch, normalizeText, normalizeTitle, similarity } from './text.js';
import { parseItem } from '../shared/parse.js';
import type { DeezerInfo, PreviewTrack, SuggestResponse } from '../shared/types.js';

const DEEZER_BASE = 'https://api.deezer.com';

/** Deezer's public API allows 50 requests / 5s; stay comfortably below. */
const queue = new SpacedQueue(130);

interface DeezerTrack {
  id: number;
  title: string;
  preview: string;
  rank?: number;
  link?: string;
  artist: { id: number; name: string };
  album: { id: number; title: string; cover_medium?: string; cover_big?: string };
}

interface DeezerSearchResponse {
  data?: DeezerTrack[];
  error?: { type?: string; message?: string; code?: number };
}

function clean(value: string): string {
  return value.replace(/"/g, '').trim();
}

async function deezerSearch(q: string, limit: number): Promise<DeezerTrack[]> {
  const url = `${DEEZER_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  for (let attempt = 0; ; attempt++) {
    let data: DeezerSearchResponse;
    try {
      data = await queue.run(() => fetchJson<DeezerSearchResponse>(url, { service: 'Deezer', timeoutMs: 10000 }));
    } catch (err) {
      // One retry for transient network failures / 5xx.
      if (attempt < 1 && err instanceof UpstreamError && (err.upstreamStatus === null || err.upstreamStatus >= 500)) {
        await sleep(800);
        continue;
      }
      throw err;
    }
    if (data?.error) {
      // Code 4 = quota exceeded: back off briefly and retry.
      if (data.error.code === 4 && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new UpstreamError(502, `Deezer: ${data.error.message || data.error.type || 'API error'}`, 200);
    }
    return data?.data ?? [];
  }
}

function plausible(track: DeezerTrack, artist: string, album: string): boolean {
  const artistOk =
    normalizeText(track.artist?.name) === normalizeText(artist) || similarity(track.artist?.name ?? '', artist) >= 0.5;
  const albumNorm = normalizeTitle(album);
  const trackAlbumNorm = normalizeTitle(track.album?.title ?? '');
  const albumOk =
    trackAlbumNorm === albumNorm ||
    trackAlbumNorm.includes(albumNorm) ||
    albumNorm.includes(trackAlbumNorm) ||
    similarity(track.album?.title ?? '', album) >= 0.5;
  return artistOk && albumOk;
}

/** Top track for an album: strict advanced search first, then a loose search validated by name. */
async function findTopTrack(artist: string, album: string): Promise<DeezerTrack | null> {
  const strict = await deezerSearch(`artist:"${clean(artist)}" album:"${clean(album)}"`, 1);
  if (strict[0]?.preview) return strict[0];
  const loose = await deezerSearch(`${clean(artist)} ${clean(album)}`, 10);
  return loose.find((t) => t.preview && plausible(t, artist, album)) ?? null;
}

export async function getDeezerInfo(artist: string, album: string): Promise<DeezerInfo> {
  const key = `deezer:info:${normalizeText(artist)}|${normalizeTitle(album)}`;
  const cached = cacheGet<DeezerInfo>(key);
  if (cached) return cached;
  const track = await findTopTrack(artist, album);
  const info: DeezerInfo = track
    ? {
        coverUrl: track.album?.cover_medium || track.album?.cover_big || null,
        popularity: typeof track.rank === 'number' ? Math.min(100, Math.round(track.rank / 10000)) : null,
        deezerAlbumId: track.album?.id ?? null,
        link: track.link ?? null,
      }
    : { coverUrl: null, popularity: null, deezerAlbumId: null, link: null };
  // Misses are cached for a shorter period so new releases show up.
  cacheSet(key, info, track ? CACHE_TTL_MS : CACHE_TTL_MS / 7);
  return info;
}

interface DeezerArtistSearchResponse {
  data?: { id: number; name: string; link?: string; picture_big?: string; picture_xl?: string; nb_fan?: number }[];
  error?: { message?: string; code?: number };
}

export interface DeezerArtist {
  imageUrl: string | null;
  fans: number | null;
  link: string | null;
}

/** Artist photo + fan count for the artist page. Only exact name matches, so we never show the wrong face. */
export async function getDeezerArtist(name: string): Promise<DeezerArtist | null> {
  const key = `deezer:artist:${normalizeText(name)}`;
  const cached = cacheGet<DeezerArtist | null>(key);
  if (cached !== undefined) return cached;
  // MusicBrainz uses typographic hyphens ("blink‐182"); Deezer search works best with plain ones.
  const q = name.replace(/[‐-―]/g, '-');
  const data = await queue.run(() =>
    fetchJson<DeezerArtistSearchResponse>(`${DEEZER_BASE}/search/artist?q=${encodeURIComponent(q)}&limit=10`, {
      service: 'Deezer',
      timeoutMs: 10000,
    }),
  );
  // Several pages can share a name (fan uploads, duplicates): the most-followed one is the real artist.
  const match =
    (data?.data ?? [])
      .filter((a) => namesMatch(a.name, name))
      .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0] ?? null;
  const picture = match?.picture_xl || match?.picture_big || null;
  const result: DeezerArtist | null = match
    ? {
        // Deezer's placeholder for artists without a photo has an empty hash ("/artist//").
        imageUrl: picture && !picture.includes('/artist//') ? picture : null,
        fans: typeof match.nb_fan === 'number' ? match.nb_fan : null,
        link: match.link ?? null,
      }
    : null;
  cacheSet(key, result, CACHE_TTL_MS);
  return result;
}

interface DeezerAlbumSearchResponse {
  data?: { id: number; title: string; cover_medium?: string; record_type?: string; artist?: { name?: string } }[];
}

function realPicture(url: string | undefined): string | null {
  return url && !/\/(artist|cover)\/\//.test(url) ? url : null;
}

/** Live search dropdown: top artists + albums from Deezer (fast; MusicBrainz is rate limited). */
export async function deezerSuggest(query: string): Promise<SuggestResponse> {
  const q = query.trim().slice(0, 120);
  const key = `deezer:suggest:${normalizeText(q)}`;
  const cached = cacheGet<SuggestResponse>(key);
  if (cached) return cached;
  const parsed = parseItem(q);
  const artistQ = parsed.album ? parsed.artist : q;
  const albumQ = parsed.album ? `artist:"${clean(parsed.artist)}" album:"${clean(parsed.album)}"` : q;
  const [artists, albums] = await Promise.all([
    queue.run(() =>
      fetchJson<DeezerArtistSearchResponse>(`${DEEZER_BASE}/search/artist?q=${encodeURIComponent(artistQ)}&limit=6`, {
        service: 'Deezer',
        timeoutMs: 8000,
      }),
    ),
    queue.run(() =>
      fetchJson<DeezerAlbumSearchResponse>(`${DEEZER_BASE}/search/album?q=${encodeURIComponent(albumQ)}&limit=15`, {
        service: 'Deezer',
        timeoutMs: 8000,
      }),
    ),
  ]);
  const seenArtists = new Set<string>();
  const artistOut = (artists?.data ?? [])
    .filter((a) => {
      const k = normalizeText(a.name);
      if (seenArtists.has(k)) return false;
      seenArtists.add(k);
      return true;
    })
    .slice(0, 3)
    .map((a) => ({ name: a.name, imageUrl: realPicture(a.picture_big), fans: a.nb_fan ?? null }));
  // Deezer lists every edition separately: keep one per title, albums/EPs before singles.
  const seenAlbums = new Set<string>();
  const rank = (t?: string) => (t === 'album' ? 0 : t === 'ep' ? 1 : 2);
  const albumOut = [...(albums?.data ?? [])]
    .sort((a, b) => rank(a.record_type) - rank(b.record_type))
    .filter((a) => {
      const k = `${normalizeText(a.artist?.name)}|${normalizeTitle(a.title)}`;
      if (seenAlbums.has(k)) return false;
      seenAlbums.add(k);
      return true;
    })
    .slice(0, 3)
    .map((a) => ({
      title: a.title,
      artist: a.artist?.name ?? '',
      coverUrl: realPicture(a.cover_medium),
      recordType: a.record_type ?? null,
    }));
  const result: SuggestResponse = { artists: artistOut, albums: albumOut };
  cacheSet(key, result, 24 * 60 * 60 * 1000);
  return result;
}

/** Preview URLs are signed and expire, so they are always fetched fresh. */
export async function getDeezerPreview(artist: string, album: string): Promise<PreviewTrack> {
  const track = await findTopTrack(artist, album);
  if (!track?.preview) throw new ApiError(404, `No Deezer preview found for ${artist} – ${album}`);
  return {
    previewUrl: track.preview,
    trackTitle: track.title,
    artistName: track.artist?.name ?? artist,
    albumTitle: track.album?.title ?? album,
    coverUrl: track.album?.cover_medium || null,
  };
}
