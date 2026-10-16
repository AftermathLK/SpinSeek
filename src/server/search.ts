import { attachLibraryInfo } from './library.js';
import {
  browseReleaseGroups,
  getArtist,
  searchArtists,
  searchReleaseGroups,
  searchReleaseGroupsByArtist,
  type MbArtist,
  type MbReleaseGroup,
  type MbRequestOptions,
} from './musicbrainz.js';
import { errorMessage, isAbortError } from './http.js';
import { namesMatch, normalizeText, normalizeTitle, similarity, stripEditionQualifiers, yearFromDate } from './text.js';
import type { AiPick, AlbumCategory, AlbumResult, ArtistSummary, ResultGroup } from '../shared/types.js';
import type { ParsedQuery } from '../shared/parse.js';

export function categorize(primaryType: string | null | undefined, secondaryTypes: string[]): AlbumCategory {
  const primary = (primaryType ?? '').toLowerCase();
  const secondary = secondaryTypes.map((s) => s.toLowerCase());
  if (secondary.includes('live')) return 'live';
  if (secondary.includes('compilation')) return 'compilation';
  if (secondary.includes('remix') || secondary.includes('dj-mix')) return 'single';
  if (primary === 'single') return 'single';
  if (secondary.length > 0) return 'other';
  if (primary === 'album') return 'studio';
  if (primary === 'ep') return 'ep';
  return 'other';
}

function toArtistSummary(a: MbArtist): ArtistSummary {
  return {
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || null,
    country: a.country || null,
    type: a.type || null,
    score: a.score,
  };
}

function creditName(rg: MbReleaseGroup): string {
  const credits = rg['artist-credit'] ?? [];
  if (credits.length === 0) return '';
  return credits.map((c) => `${c.name}${c.joinphrase ?? ''}`).join('').trim();
}

function toAlbumResult(rg: MbReleaseGroup, artist: { mbid: string; name: string } | null): AlbumResult {
  const primaryCredit = rg['artist-credit']?.[0]?.artist;
  const secondaryTypes = rg['secondary-types'] ?? [];
  const { isEditionTitle } = stripEditionQualifiers(rg.title);
  const rating = rg.rating?.value;
  return {
    mbid: rg.id,
    title: rg.title,
    artistName: artist?.name ?? (creditName(rg) || primaryCredit?.name || 'Unknown Artist'),
    artistMbid: artist?.mbid ?? primaryCredit?.id ?? '',
    year: yearFromDate(rg['first-release-date']),
    firstReleaseDate: rg['first-release-date'] || null,
    primaryType: rg['primary-type'] ?? null,
    secondaryTypes,
    category: categorize(rg['primary-type'], secondaryTypes),
    isEditionTitle,
    isEdition: false,
    canonicalMbid: null,
    collapsedEditions: [],
    editionLibraryStatus: null,
    communityRating: typeof rating === 'number' && rating > 0 ? Math.round(rating * 10) / 10 : null,
    communityVotes: rg.rating?.['votes-count'] ?? 0,
    lidarrStatus: 'not_in_lidarr',
    lidarrAlbumId: null,
    cutoffUnmet: false,
    lastSearchedAt: null,
    userRating: null,
  };
}

function compareDates(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

/**
 * Canonical deduplication: release groups that share an artist, category and normalized base title
 * ("X", "X (Deluxe Edition)", "X - 2015 Remaster") collapse into the earliest plain-titled one.
 */
export function applyCanonicalDedup(albums: AlbumResult[]): AlbumResult[] {
  const groups = new Map<string, AlbumResult[]>();
  for (const album of albums) {
    const key = `${album.artistMbid}|${album.category}|${normalizeTitle(album.title)}`;
    const list = groups.get(key);
    if (list) list.push(album);
    else groups.set(key, [album]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => Number(a.isEditionTitle) - Number(b.isEditionTitle) || compareDates(a.firstReleaseDate, b.firstReleaseDate));
    const [canonical, ...rest] = members;
    canonical.isEdition = false;
    canonical.canonicalMbid = null;
    canonical.collapsedEditions = rest.map((r) => ({ mbid: r.mbid, title: r.title, year: r.year }));
    for (const r of rest) {
      r.isEdition = true;
      r.canonicalMbid = canonical.mbid;
    }
  }
  return albums;
}

function sortDiscography(albums: AlbumResult[]): AlbumResult[] {
  return albums.sort((a, b) => compareDates(a.firstReleaseDate, b.firstReleaseDate) || a.title.localeCompare(b.title));
}

function emptyGroup(id: string, query: string, kind: ResultGroup['kind']): ResultGroup {
  return { id, query, kind, artist: null, alternatives: [], albums: [], error: null, notices: [], albumQuery: null };
}

/**
 * Exact name matches win (MusicBrainz order breaks ties, e.g. the famous Nirvana first). Otherwise the
 * closest name by typo-tolerant similarity, and nothing at all if no candidate is reasonably close.
 */
function pickBestArtist(query: string, artists: MbArtist[]): MbArtist | null {
  if (artists.length === 0) return null;
  const exact = artists.filter(
    (a) => (a.score ?? 0) >= 80 && (namesMatch(a.name, query) || namesMatch(a['sort-name'] ?? '', query)),
  );
  if (exact[0]) return exact[0];
  const ranked = artists
    .map((a) => ({ a, sim: Math.max(similarity(a.name, query), similarity(a['sort-name'] ?? '', query)) }))
    .sort((x, y) => y.sim - x.sim || (y.a.score ?? 0) - (x.a.score ?? 0));
  return ranked[0].sim >= 0.34 ? ranked[0].a : null;
}

/** Discography for a specific artist MBID. */
export async function resolveArtistByMbid(
  id: string,
  query: string,
  mbid: string,
  opts: MbRequestOptions = {},
  alternatives: ArtistSummary[] = [],
  known?: ArtistSummary,
): Promise<ResultGroup> {
  const group = emptyGroup(id, query, 'artist');
  const artist = known ?? toArtistSummary(await getArtist(mbid, opts));
  group.artist = artist;
  group.alternatives = alternatives;
  const rgs = await browseReleaseGroups(mbid, opts);
  const albums = rgs.map((rg) => toAlbumResult(rg, { mbid: artist.mbid, name: artist.name }));
  group.albums = attachLibraryInfo(applyCanonicalDedup(sortDiscography(albums)));
  if (group.albums.length === 0) group.notices.push('MusicBrainz lists no release groups for this artist.');
  return group;
}

async function resolveArtistQuery(id: string, parsed: ParsedQuery, opts: MbRequestOptions): Promise<ResultGroup> {
  const artists = await searchArtists(parsed.artist, opts);
  const best = pickBestArtist(parsed.artist, artists);
  if (!best) {
    const group = emptyGroup(id, parsed.raw, 'artist');
    group.error = `No artist found on MusicBrainz for "${parsed.artist}"`;
    return group;
  }
  const alternatives = artists.filter((a) => a.id !== best.id).map(toArtistSummary);
  const group = await resolveArtistByMbid(id, parsed.raw, best.id, opts, alternatives, toArtistSummary(best));
  if (!namesMatch(best.name, parsed.artist) && !namesMatch(best['sort-name'] ?? '', parsed.artist)) {
    group.notices.unshift(`Showing results for “${best.name}” (searched “${parsed.artist}”).`);
  }
  return group;
}

function scoreCandidate(rg: MbReleaseGroup, artistQuery: string, albumQuery: string): number {
  let score = rg.score ?? 0;
  const titleNorm = normalizeTitle(rg.title);
  const queryNorm = normalizeTitle(albumQuery);
  if (titleNorm === queryNorm) score += 50;
  else if (titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm)) score += 15;
  else score += Math.round(similarity(rg.title, albumQuery) * 20);

  const credit = creditName(rg);
  const primary = rg['artist-credit']?.[0]?.artist?.name ?? '';
  if (namesMatch(credit, artistQuery) || namesMatch(primary, artistQuery)) score += 30;
  else if (similarity(credit, artistQuery) >= 0.5) score += 10;

  const queryWantsEdition = stripEditionQualifiers(albumQuery).isEditionTitle;
  const { isEditionTitle } = stripEditionQualifiers(rg.title);
  if (queryWantsEdition) {
    if (normalizeText(rg.title) === normalizeText(albumQuery)) score += 25;
  } else if (!isEditionTitle) {
    score += 10;
  }
  const category = categorize(rg['primary-type'], rg['secondary-types'] ?? []);
  if (category === 'studio') score += 8;
  else if (category === 'ep') score += 3;
  return score;
}

function rankCandidates(rgs: MbReleaseGroup[], artist: string, album: string): MbReleaseGroup[] {
  return rgs
    .map((rg) => ({ rg, score: scoreCandidate(rg, artist, album) }))
    .sort((a, b) => b.score - a.score || compareDates(a.rg['first-release-date'] ?? null, b.rg['first-release-date'] ?? null))
    .map((x) => x.rg);
}

function isPlausibleMatch(rg: MbReleaseGroup, artist: string, album: string): boolean {
  const titleNorm = normalizeTitle(rg.title);
  const queryNorm = normalizeTitle(album);
  const titleOk =
    titleNorm === queryNorm ||
    (queryNorm.length > 3 && (titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm))) ||
    similarity(rg.title, album) >= 0.5;
  const credit = creditName(rg);
  const primary = rg['artist-credit']?.[0]?.artist?.name ?? '';
  const artistOk =
    namesMatch(credit, artist) ||
    namesMatch(primary, artist) ||
    similarity(credit, artist) >= 0.5 ||
    similarity(primary, artist) >= 0.5;
  return titleOk && artistOk;
}

/**
 * "Artist - Album" lookup: a direct release-group search first. If nothing plausible comes back (typos,
 * odd artist spellings like "blink‐182"), resolve the artist on its own and search only their albums.
 */
async function findAlbum(
  artist: string,
  album: string,
  opts: MbRequestOptions,
): Promise<{ ranked: MbReleaseGroup[]; best: MbReleaseGroup } | null> {
  const ranked = rankCandidates(await searchReleaseGroups(artist, album, opts), artist, album);
  if (ranked[0] && isPlausibleMatch(ranked[0], artist, album)) return { ranked, best: ranked[0] };
  const resolved = pickBestArtist(artist, await searchArtists(artist, opts));
  if (!resolved) return null;
  const scoped = rankCandidates(await searchReleaseGroupsByArtist(resolved.id, album, opts), resolved.name, album);
  if (scoped[0] && isPlausibleMatch(scoped[0], resolved.name, album)) return { ranked: scoped, best: scoped[0] };
  return null;
}

async function resolveAlbumQuery(id: string, parsed: ParsedQuery, opts: MbRequestOptions): Promise<ResultGroup> {
  const albumQuery = parsed.album ?? '';
  const group = emptyGroup(id, parsed.raw, 'album');
  group.albumQuery = albumQuery;
  const found = await findAlbum(parsed.artist, albumQuery, opts);
  if (!found) {
    group.error = `No release found on MusicBrainz for "${parsed.artist} – ${albumQuery}"`;
    return group;
  }
  const { ranked, best } = found;
  const bestArtist = best['artist-credit']?.[0]?.artist;
  if (bestArtist) {
    group.artist = {
      mbid: bestArtist.id,
      name: bestArtist.name,
      disambiguation: bestArtist.disambiguation || null,
      country: null,
      type: null,
    };
  }
  // Keep candidates by the same primary artist so covers by other artists don't clutter the group.
  const sameArtist = ranked.filter((rg) => !bestArtist || rg['artist-credit']?.[0]?.artist?.id === bestArtist.id);
  const albums = applyCanonicalDedup(
    sortDiscography(sameArtist.map((rg) => toAlbumResult(rg, bestArtist ? { mbid: bestArtist.id, name: bestArtist.name } : null))),
  );
  const bestResult = albums.find((a) => a.mbid === best.id);
  if (bestResult) {
    const wantsEdition = stripEditionQualifiers(albumQuery).isEditionTitle;
    const target =
      bestResult.isEdition && !wantsEdition ? (albums.find((a) => a.mbid === bestResult.canonicalMbid) ?? bestResult) : bestResult;
    target.autoCheck = true;
    target.pinned = true;
    const queryNorm = normalizeTitle(albumQuery);
    if (normalizeTitle(target.title) !== queryNorm || (bestArtist && !namesMatch(bestArtist.name, parsed.artist))) {
      group.notices.unshift(`Closest match: “${target.title}” by ${target.artistName}.`);
    }
  }
  group.albums = attachLibraryInfo(albums);
  return group;
}

/** Resolve one parsed Omnibar query (artist discography or targeted album). */
export async function resolveQuery(id: string, parsed: ParsedQuery, opts: MbRequestOptions = {}): Promise<ResultGroup> {
  try {
    return parsed.album ? await resolveAlbumQuery(id, parsed, opts) : await resolveArtistQuery(id, parsed, opts);
  } catch (err) {
    if (isAbortError(err)) throw err;
    const group = emptyGroup(id, parsed.raw, parsed.album ? 'album' : 'artist');
    group.error = errorMessage(err);
    return group;
  }
}

/** The canonical (non-deluxe) album for the best-ranked release group. */
function albumFromRanked(ranked: MbReleaseGroup[], best: MbReleaseGroup): AlbumResult | null {
  const bestArtist = best['artist-credit']?.[0]?.artist;
  const artistRef = bestArtist ? { mbid: bestArtist.id, name: bestArtist.name } : null;
  const sameArtist = ranked.filter((rg) => !bestArtist || rg['artist-credit']?.[0]?.artist?.id === bestArtist.id);
  const albums = applyCanonicalDedup(sortDiscography(sameArtist.map((rg) => toAlbumResult(rg, artistRef))));
  let chosen = albums.find((a) => a.mbid === best.id) ?? null;
  if (chosen?.isEdition) chosen = albums.find((a) => a.mbid === chosen?.canonicalMbid) ?? chosen;
  return chosen;
}

/** Stage 2 of AI discovery: verify a pick against MusicBrainz release groups. */
export async function resolveAiPick(pick: AiPick, opts: MbRequestOptions = {}): Promise<AlbumResult | null> {
  const found = await findAlbum(pick.artist, pick.album, opts);
  if (!found) return null;
  const chosen = albumFromRanked(found.ranked, found.best);
  if (!chosen) return null;
  chosen.reason = pick.reason;
  chosen.source = 'ai';
  chosen.pinned = true;
  attachLibraryInfo([chosen]);
  return chosen;
}

/** Best MusicBrainz artist for a name (typo/alias tolerant), or null. */
export async function resolveArtistName(name: string, opts: MbRequestOptions = {}): Promise<ArtistSummary | null> {
  const best = pickBestArtist(name, await searchArtists(name, opts));
  return best ? toArtistSummary(best) : null;
}

/**
 * "This artist's album called X" → canonical release group. Uses the artist MBID when known (one
 * request), otherwise the typo-tolerant album lookup. `requireStudio` skips compilations/live/singles.
 */
export async function resolveArtistAlbum(
  artist: { mbid: string | null; name: string },
  title: string,
  opts: MbRequestOptions = {},
  requireStudio = false,
): Promise<AlbumResult | null> {
  let found: { ranked: MbReleaseGroup[]; best: MbReleaseGroup } | null = null;
  if (artist.mbid) {
    const scoped = rankCandidates(await searchReleaseGroupsByArtist(artist.mbid, title, opts), artist.name, title);
    if (scoped[0] && isPlausibleMatch(scoped[0], artist.name, title)) found = { ranked: scoped, best: scoped[0] };
  }
  found ??= await findAlbum(artist.name, title, opts);
  if (!found) return null;
  const album = albumFromRanked(found.ranked, found.best);
  if (!album || (requireStudio && album.category !== 'studio')) return null;
  album.pinned = true;
  attachLibraryInfo([album]);
  return album;
}
