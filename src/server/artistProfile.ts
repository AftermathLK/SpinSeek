// Artist page data: MusicBrainz profile + Wikipedia summary + Deezer photo, merged with library stats.
import { CACHE_TTL_MS, USER_AGENT } from './config.js';
import { cacheGet, cacheSet, db } from './db.js';
import { getDeezerArtist } from './deezer.js';
import { errorMessage, fetchJson } from './http.js';
import { getArtistDetails, type MbArtistDetails } from './musicbrainz.js';
import type { ArtistLink, ArtistProfile } from '../shared/types.js';

type Relation = NonNullable<MbArtistDetails['relations']>[number];

const LINK_LABELS: Record<string, string> = {
  'official homepage': 'Official site',
  bandcamp: 'Bandcamp',
  soundcloud: 'SoundCloud',
  discogs: 'Discogs',
  allmusic: 'AllMusic',
  'last.fm': 'Last.fm',
  youtube: 'YouTube',
};

const BIO_MAX = 1200;

async function wikipediaTitle(relations: Relation[]): Promise<string | null> {
  const wiki = relations.find((r) => r.type === 'wikipedia' && /\/\/en\.wikipedia\.org\/wiki\//.test(r.url?.resource ?? ''));
  if (wiki?.url) return decodeURIComponent(wiki.url.resource.split('/wiki/')[1] ?? '').replace(/_/g, ' ') || null;
  const qid = relations.find((r) => r.type === 'wikidata')?.url?.resource.match(/(Q\d+)\/?$/)?.[1];
  if (!qid) return null;
  const data = await fetchJson<{ entities?: Record<string, { sitelinks?: { enwiki?: { title: string } } }> }>(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`,
    { service: 'Wikidata', headers: { 'User-Agent': USER_AGENT }, timeoutMs: 10000 },
  );
  return data?.entities?.[qid]?.sitelinks?.enwiki?.title ?? null;
}

async function wikipediaSummary(title: string): Promise<{ extract: string; url: string; image: string | null } | null> {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  const data = await fetchJson<{
    type?: string;
    extract?: string;
    thumbnail?: { source: string };
    content_urls?: { desktop?: { page?: string } };
  }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
    service: 'Wikipedia',
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: 10000,
  });
  if (!data?.extract || data.type === 'disambiguation') return null;
  let extract = data.extract.trim();
  if (extract.length > BIO_MAX) {
    const cut = extract.lastIndexOf('. ', BIO_MAX);
    extract = `${extract.slice(0, cut > 200 ? cut + 1 : BIO_MAX).trim()}…`;
  }
  return { extract, url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`, image: data.thumbnail?.source ?? null };
}

function collectLinks(mbid: string, relations: Relation[], extra: ArtistLink[]): ArtistLink[] {
  const links: ArtistLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, url: string) => {
    // Links come from third-party data: only plain http(s) URLs are allowed into an href.
    if (!url || seen.has(label) || !/^https?:\/\//i.test(url)) return;
    seen.add(label);
    links.push({ label, url });
  };
  for (const r of relations) {
    const label = LINK_LABELS[r.type];
    if (label && r.url?.resource) add(label, r.url.resource);
  }
  for (const l of extra) add(l.label, l.url);
  add('MusicBrainz', `https://musicbrainz.org/artist/${mbid}`);
  return links;
}

function libraryInfo(mbid: string): ArtistProfile['library'] {
  const artist = db.prepare('SELECT lidarr_id, size_on_disk FROM library_artists WHERE artist_mbid = ?').get(mbid) as
    | { lidarr_id: number | null; size_on_disk: number | null }
    | undefined;
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(status = 'downloaded'), 0) AS downloaded,
         COALESCE(SUM(status = 'missing_monitored' OR (status = 'partial' AND monitored = 1)), 0) AS missing
       FROM library_albums WHERE artist_mbid = ?`,
    )
    .get(mbid) as { total: number; downloaded: number; missing: number };
  return {
    inLidarr: Boolean(artist?.lidarr_id),
    total: counts.total,
    downloaded: counts.downloaded,
    missing: counts.missing,
    sizeOnDisk: artist?.size_on_disk ?? 0,
  };
}

/** Bio/photo lookups are best-effort: a failure there never breaks the artist page. */
export async function getArtistProfile(mbid: string): Promise<ArtistProfile> {
  const key = `artist-profile:v2:${mbid}`;
  let base = cacheGet<Omit<ArtistProfile, 'library'>>(key);
  if (!base) {
    const a = await getArtistDetails(mbid);
    const relations = a.relations ?? [];
    const [wiki, deezer] = await Promise.all([
      wikipediaTitle(relations)
        .then((t) => (t ? wikipediaSummary(t) : null))
        .catch((err) => {
          console.warn(`[artist] Wikipedia lookup for ${a.name}: ${errorMessage(err)}`);
          return null;
        }),
      getDeezerArtist(a.name).catch(() => null),
    ]);
    const genreSource = a.genres?.length ? a.genres : (a.tags ?? []);
    const rating = a.rating?.value;
    base = {
      mbid: a.id,
      name: a.name,
      disambiguation: a.disambiguation || null,
      type: a.type || null,
      country: a.country || null,
      area: a.area?.name || a['begin-area']?.name || null,
      lifeSpan: {
        begin: a['life-span']?.begin || null,
        end: a['life-span']?.end || null,
        ended: Boolean(a['life-span']?.ended),
      },
      genres: [...genreSource]
        .sort((x, y) => y.count - x.count)
        .slice(0, 6)
        .map((g) => g.name),
      communityRating: typeof rating === 'number' && rating > 0 ? Math.round(rating * 10) / 10 : null,
      communityVotes: a.rating?.['votes-count'] ?? 0,
      bio: wiki?.extract ?? null,
      wikipediaUrl: wiki?.url ?? null,
      imageUrl: deezer?.imageUrl ?? wiki?.image ?? null,
      fans: deezer?.fans ?? null,
      links: collectLinks(a.id, relations, [
        ...(wiki ? [{ label: 'Wikipedia', url: wiki.url }] : []),
        ...(deezer?.link ? [{ label: 'Deezer', url: deezer.link }] : []),
      ]),
    };
    cacheSet(key, base, CACHE_TTL_MS);
  }
  return { ...base, library: libraryInfo(mbid) };
}
