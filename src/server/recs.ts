// 📻 Recommendations (no LLM): Last.fm similarity + top albums, verified against MusicBrainz.
import { cacheGet, cacheSet, db } from './db.js';
import { getDeezerArtist } from './deezer.js';
import { ApiError, errorMessage, isAbortError, mapPool, type NdjsonStream } from './http.js';
import { getArtistTopAlbums, getSimilarArtists, getUserTopAlbums, lastfmUsername, type LastfmArtistRef } from './lastfm.js';
import { getArtistDetails, type MbRequestOptions } from './musicbrainz.js';
import { resolveArtistAlbum, resolveArtistName } from './search.js';
import { normalizeText } from './text.js';
import type { AlbumResult, LastfmPeriod, RecsEvent, RecsRequest, SimilarArtist } from '../shared/types.js';

const SEEDS_PER_RUN = 5;
const FOR_YOU_ARTISTS = 12;
const SIMILAR_ARTISTS = 12;
const SCROBBLE_ALBUMS = 20;

const PERIOD_LABELS: Record<LastfmPeriod, string> = {
  '7day': 'last 7 days',
  '1month': 'last month',
  '6month': 'last 6 months',
  overall: 'all time',
};

interface Seed {
  name: string;
  mbid: string | null;
}

/** Seed pool: artists of 4★+ rated albums first, then the most-collected Lidarr artists. */
function seedPool(): Seed[] {
  const rated = db
    .prepare(
      `SELECT artist_name AS name, MAX(user_rating) AS rating, MAX(updated_at) AS at FROM ratings
       WHERE user_rating >= 4 GROUP BY artist_name ORDER BY rating DESC, at DESC LIMIT 25`,
    )
    .all() as { name: string }[];
  const collected = db
    .prepare('SELECT name, artist_mbid AS mbid FROM library_artists WHERE track_file_count > 0 ORDER BY track_file_count DESC LIMIT 25')
    .all() as { name: string; mbid: string }[];
  const byName = new Map<string, Seed>();
  for (const r of rated) byName.set(normalizeText(r.name), { name: r.name, mbid: null });
  for (const c of collected) {
    const key = normalizeText(c.name);
    const existing = byName.get(key);
    if (existing) existing.mbid ??= c.mbid;
    else byName.set(key, { name: c.name, mbid: c.mbid });
  }
  return [...byName.values()];
}

function sample<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * First canonical studio album among the artist's most-played albums. Albums you already have are
 * skipped when possible, so recommendations surface something new.
 */
async function bestStudioAlbum(artist: Seed, opts: MbRequestOptions): Promise<AlbumResult | null> {
  const top = await getArtistTopAlbums(artist.name, artist.mbid, 8);
  if (top.length === 0) return null;
  const ref = artist.mbid ? artist : await resolveArtistName(artist.name, opts).then((a) => (a ? { mbid: a.mbid, name: a.name } : null));
  if (!ref) return null;
  let owned: AlbumResult | null = null;
  for (const album of top.slice(0, 4)) {
    const result = await resolveArtistAlbum(ref, album.title, opts, true);
    if (!result) continue;
    if (result.lidarrStatus !== 'downloaded') return result;
    owned ??= result;
  }
  return owned;
}

function finish(album: AlbumResult, reason: string): AlbumResult {
  album.reason = reason;
  album.source = 'recs';
  album.alreadyOwned = album.lidarrStatus === 'downloaded';
  return album;
}

/** Round-robin across seeds so one seed can't fill the whole list. */
function interleave(lists: { seed: Seed; similar: LastfmArtistRef[] }[], exclude: Set<string>, max: number) {
  const picked: { artist: LastfmArtistRef; because: string }[] = [];
  const seen = new Set(exclude);
  for (let i = 0; picked.length < max && lists.some((l) => i < l.similar.length); i++) {
    for (const { seed, similar } of lists) {
      const a = similar[i];
      if (!a || picked.length >= max) continue;
      const key = normalizeText(a.name);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ artist: a, because: seed.name });
    }
  }
  return picked;
}

const pct = (match: number) => `${Math.round(match * 100)}% match`;

async function forYou(req: RecsRequest, stream: NdjsonStream, opts: MbRequestOptions): Promise<number> {
  const pool = seedPool();
  if (pool.length === 0) {
    throw new ApiError(400, 'Rate a few albums 4★ or higher, or sync your Lidarr library, so Spin Seek knows your taste. Or try "Similar to Artist".');
  }
  const used = new Set((req.excludeSeeds ?? []).map(normalizeText));
  let candidates = pool.filter((s) => !used.has(normalizeText(s.name)));
  if (candidates.length === 0) candidates = pool; // every seed used: start over
  const seeds = req.shuffle ? sample(candidates, SEEDS_PER_RUN) : candidates.slice(0, SEEDS_PER_RUN);
  stream.send({ type: 'seeds', seeds: seeds.map((s) => s.name) } satisfies RecsEvent);
  stream.send({ type: 'status', message: 'Finding similar artists on Last.fm…' } satisfies RecsEvent);

  const lists = await mapPool(seeds, 2, async (seed) => ({
    seed,
    similar: await getSimilarArtists(seed.name, seed.mbid, 10)
      .then((r) => r.artists)
      .catch(() => []),
  }));
  const picks = interleave(lists, new Set(pool.map((s) => normalizeText(s.name))), FOR_YOU_ARTISTS);
  if (picks.length === 0) throw new ApiError(404, 'Last.fm had no similar artists for these seeds. Try Shuffle Seeds.');
  stream.send({ type: 'status', message: `Picking albums from ${picks.length} similar artists…` } satisfies RecsEvent);

  let count = 0;
  await mapPool(picks, 2, async ({ artist, because }) => {
    if (stream.closed) return;
    const album = await bestStudioAlbum(artist, opts).catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
    if (!album) return;
    count++;
    stream.send({ type: 'album', album: finish(album, `Because you like ${because} (${pct(artist.match)})`) } satisfies RecsEvent);
  });
  return count;
}

async function similarTo(req: RecsRequest, stream: NdjsonStream, opts: MbRequestOptions): Promise<number> {
  const name = (req.artist ?? '').trim();
  if (!name) throw new ApiError(400, 'Enter an artist.');
  stream.send({ type: 'status', message: `Finding artists similar to ${name}…` } satisfies RecsEvent);
  const { artists, resolvedName } = await getSimilarArtists(name, null, SIMILAR_ARTISTS + 4);
  if (artists.length === 0) throw new ApiError(404, `Last.fm doesn't know any artists similar to "${name}".`);
  const picks = artists.filter((a) => normalizeText(a.name) !== normalizeText(resolvedName)).slice(0, SIMILAR_ARTISTS);
  let count = 0;
  await mapPool(picks, 2, async (artist) => {
    if (stream.closed) return;
    const album = await bestStudioAlbum(artist, opts).catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
    if (!album) return;
    count++;
    stream.send({ type: 'album', album: finish(album, `Similar to ${resolvedName} (${pct(artist.match)})`) } satisfies RecsEvent);
  });
  return count;
}

async function scrobbles(req: RecsRequest, stream: NdjsonStream, opts: MbRequestOptions): Promise<number> {
  const user = lastfmUsername();
  if (!user) throw new ApiError(400, 'Add your Last.fm username in Settings → Last.fm.');
  const period: LastfmPeriod = req.period && req.period in PERIOD_LABELS ? req.period : '1month';
  stream.send({ type: 'status', message: `Loading ${user}'s top albums (${PERIOD_LABELS[period]})…` } satisfies RecsEvent);
  const top = (await getUserTopAlbums(user, period, 40)).slice(0, SCROBBLE_ALBUMS);
  if (top.length === 0) throw new ApiError(404, `No scrobbled albums for ${PERIOD_LABELS[period]}.`);
  let count = 0;
  await mapPool(top, 2, async (entry) => {
    if (stream.closed) return;
    const album = await resolveArtistAlbum({ mbid: entry.artistMbid, name: entry.artist }, entry.title, opts).catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
    if (!album) return;
    count++;
    stream.send({
      type: 'album',
      album: finish(album, `${entry.playcount.toLocaleString('en-US')} plays (${PERIOD_LABELS[period]})`),
    } satisfies RecsEvent);
  });
  return count;
}

export async function runRecs(req: RecsRequest, stream: NdjsonStream): Promise<void> {
  const opts: MbRequestOptions = { signal: stream.signal };
  try {
    const count = req.mode === 'similar' ? await similarTo(req, stream, opts) : req.mode === 'scrobbles' ? await scrobbles(req, stream, opts) : await forYou(req, stream, opts);
    stream.send({ type: 'done', count } satisfies RecsEvent);
  } catch (err) {
    if (!isAbortError(err)) stream.send({ type: 'error', error: errorMessage(err) } satisfies RecsEvent);
  }
}

/** Artist page "Similar Artists" row: Last.fm similarity + Deezer photos. */
export async function similarArtistsFor(mbid: string): Promise<SimilarArtist[]> {
  const cacheKey = `similar-artists:v1:${mbid}`;
  const cached = cacheGet<SimilarArtist[]>(cacheKey);
  if (cached) return cached;
  let { artists } = await getSimilarArtists('', mbid, 12);
  if (artists.length === 0) {
    const details = await getArtistDetails(mbid);
    artists = (await getSimilarArtists(details.name, null, 12)).artists;
  }
  const result = await mapPool(artists.slice(0, 12), 3, async (a) => ({
    name: a.name,
    mbid: a.mbid,
    match: Math.round(a.match * 100),
    imageUrl: (await getDeezerArtist(a.name).catch(() => null))?.imageUrl ?? null,
  }));
  cacheSet(cacheKey, result, 24 * 60 * 60 * 1000);
  return result;
}
