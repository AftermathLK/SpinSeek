import { chunk, db } from './db.js';
import type {
  AlbumResult,
  LibraryAlbum,
  LibraryArtist,
  LibraryFilter,
  LibraryStats,
  LidarrStatus,
} from '../shared/types.js';

interface AlbumInfoRow {
  album_mbid: string;
  lidarr_album_id: number | null;
  status: string;
  cutoff_unmet: number | null;
  last_searched_at: number | null;
}

export interface LibraryInfo {
  status: LidarrStatus;
  lidarrAlbumId: number | null;
  cutoffUnmet: boolean;
  lastSearchedAt: number | null;
}

export function libraryInfoFor(mbids: string[]): Map<string, LibraryInfo> {
  const out = new Map<string, LibraryInfo>();
  for (const part of chunk([...new Set(mbids)], 500)) {
    if (part.length === 0) continue;
    const rows = db
      .prepare(
        `SELECT album_mbid, lidarr_album_id, status, cutoff_unmet, last_searched_at
         FROM library_albums WHERE album_mbid IN (${part.map(() => '?').join(',')})`,
      )
      .all(...part) as AlbumInfoRow[];
    for (const r of rows) {
      out.set(r.album_mbid, {
        status: (r.status as LidarrStatus) || 'unmonitored',
        lidarrAlbumId: r.lidarr_album_id,
        cutoffUnmet: r.cutoff_unmet === 1,
        lastSearchedAt: r.last_searched_at,
      });
    }
  }
  return out;
}

export function ratingsFor(mbids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of chunk([...new Set(mbids)], 500)) {
    if (part.length === 0) continue;
    const rows = db
      .prepare(`SELECT album_mbid, user_rating FROM ratings WHERE album_mbid IN (${part.map(() => '?').join(',')})`)
      .all(...part) as { album_mbid: string; user_rating: number | null }[];
    for (const r of rows) if (r.user_rating) out.set(r.album_mbid, r.user_rating);
  }
  return out;
}

const STATUS_RANK: Record<LidarrStatus, number> = {
  downloaded: 4,
  partial: 3,
  missing_monitored: 2,
  unmonitored: 1,
  not_in_lidarr: 0,
};

/** Merge Lidarr status, cooldown and personal ratings into search results (mutates in place). */
export function attachLibraryInfo(albums: AlbumResult[]): AlbumResult[] {
  const mbids = albums.flatMap((a) => [a.mbid, ...a.collapsedEditions.map((e) => e.mbid)]);
  const info = libraryInfoFor(mbids);
  const ratings = ratingsFor(albums.map((a) => a.mbid));
  for (const album of albums) {
    const i = info.get(album.mbid);
    album.lidarrStatus = i?.status ?? 'not_in_lidarr';
    album.lidarrAlbumId = i?.lidarrAlbumId ?? null;
    album.cutoffUnmet = i?.cutoffUnmet ?? false;
    album.lastSearchedAt = i?.lastSearchedAt ?? null;
    album.userRating = ratings.get(album.mbid) ?? null;
    let best: LidarrStatus | null = null;
    for (const e of album.collapsedEditions) {
      const s = info.get(e.mbid)?.status;
      if (s && (!best || STATUS_RANK[s] > STATUS_RANK[best])) best = s;
    }
    album.editionLibraryStatus = best;
  }
  return albums;
}

// ---------------------------------------------------------------------------
// Library tab queries
// ---------------------------------------------------------------------------

const MISSING_SQL = "(al.status = 'missing_monitored' OR (al.status = 'partial' AND al.monitored = 1))";

function filterSql(filter: LibraryFilter): string {
  switch (filter) {
    case 'downloaded':
      return "al.status = 'downloaded'";
    case 'missing':
      return MISSING_SQL;
    case 'cutoff':
      return 'al.cutoff_unmet = 1';
    case 'unmonitored':
      return 'al.monitored = 0';
    case 'favorites':
      return 'r.user_rating >= 4';
    default:
      return '1 = 1';
  }
}

export function parseFilter(value: unknown): LibraryFilter {
  const allowed: LibraryFilter[] = ['all', 'downloaded', 'missing', 'cutoff', 'unmonitored', 'favorites'];
  return allowed.includes(value as LibraryFilter) ? (value as LibraryFilter) : 'all';
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function searchSql(q: string): { sql: string; params: string[] } {
  const terms = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (terms.length === 0) return { sql: '1 = 1', params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    parts.push(
      "(al.artist_name LIKE ? ESCAPE '\\' OR al.title LIKE ? ESCAPE '\\' OR CAST(al.year AS TEXT) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like);
  }
  return { sql: parts.join(' AND '), params };
}

export type LibrarySort = 'artist' | 'newest' | 'oldest' | 'title' | 'searched';

function orderSql(sort: LibrarySort): string {
  switch (sort) {
    case 'newest':
      return 'al.year DESC NULLS LAST, al.artist_name COLLATE NOCASE, al.title COLLATE NOCASE';
    case 'oldest':
      return 'al.year ASC NULLS LAST, al.artist_name COLLATE NOCASE, al.title COLLATE NOCASE';
    case 'title':
      return 'al.title COLLATE NOCASE, al.artist_name COLLATE NOCASE';
    case 'searched':
      return 'al.last_searched_at ASC NULLS FIRST, al.artist_name COLLATE NOCASE';
    default:
      return 'al.artist_name COLLATE NOCASE, al.year ASC NULLS LAST, al.title COLLATE NOCASE';
  }
}

interface LibraryAlbumRow {
  album_mbid: string;
  lidarr_album_id: number | null;
  artist_mbid: string;
  artist_name: string;
  title: string;
  year: number | null;
  primary_type: string | null;
  secondary_types: string | null;
  monitored: number;
  status: string;
  percent_of_tracks: number | null;
  cutoff_unmet: number | null;
  cover_url: string | null;
  last_searched_at: number | null;
  user_rating: number | null;
  queued: number;
}

function mapAlbumRow(r: LibraryAlbumRow): LibraryAlbum {
  return {
    albumMbid: r.album_mbid,
    lidarrAlbumId: r.lidarr_album_id,
    artistMbid: r.artist_mbid,
    artistName: r.artist_name,
    title: r.title,
    year: r.year,
    primaryType: r.primary_type,
    secondaryTypes: r.secondary_types ? r.secondary_types.split(',').filter(Boolean) : [],
    monitored: r.monitored === 1,
    status: (r.status as LibraryAlbum['status']) || 'unmonitored',
    percentOfTracks: r.percent_of_tracks ?? 0,
    cutoffUnmet: r.cutoff_unmet === 1,
    coverUrl: r.cover_url,
    lastSearchedAt: r.last_searched_at,
    userRating: r.user_rating,
    queued: r.queued === 1,
  };
}

export interface AlbumQuery {
  q: string;
  filter: LibraryFilter;
  artistMbid?: string;
  sort: LibrarySort;
  limit: number;
  offset: number;
}

export function queryLibraryAlbums(query: AlbumQuery): { items: LibraryAlbum[]; total: number } {
  const search = searchSql(query.q);
  const where = [filterSql(query.filter), search.sql];
  const params: (string | number)[] = [...search.params];
  if (query.artistMbid) {
    where.push('al.artist_mbid = ?');
    params.push(query.artistMbid);
  }
  const from = `FROM library_albums al LEFT JOIN ratings r ON r.album_mbid = al.album_mbid WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT al.*, r.user_rating,
         EXISTS(SELECT 1 FROM drip_queue dq WHERE dq.album_mbid = al.album_mbid AND dq.status IN ('pending','processing')) AS queued
       ${from} ORDER BY ${orderSql(query.sort)} LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset) as LibraryAlbumRow[];
  return { items: rows.map(mapAlbumRow), total };
}

export function queryLibraryArtists(q: string, filter: LibraryFilter): LibraryArtist[] {
  const search = searchSql(q);
  const rows = db
    .prepare(
      `SELECT al.artist_mbid AS artist_mbid,
         COALESCE(MAX(la.name), MAX(al.artist_name)) AS name,
         MAX(la.lidarr_id) AS lidarr_id,
         COALESCE(MAX(la.monitored), 0) AS monitored,
         COALESCE(MAX(la.size_on_disk), 0) AS size_on_disk,
         COUNT(*) AS total,
         SUM(al.status = 'downloaded') AS downloaded,
         SUM(${MISSING_SQL}) AS missing,
         SUM(al.status = 'partial') AS partial,
         SUM(al.cutoff_unmet = 1) AS cutoff,
         (SELECT a2.cover_url FROM library_albums a2 WHERE a2.artist_mbid = al.artist_mbid AND a2.cover_url IS NOT NULL
            ORDER BY (a2.status = 'downloaded') DESC, a2.year DESC LIMIT 1) AS cover_url
       FROM library_albums al
       LEFT JOIN library_artists la ON la.artist_mbid = al.artist_mbid
       LEFT JOIN ratings r ON r.album_mbid = al.album_mbid
       WHERE ${filterSql(filter)} AND ${search.sql}
       GROUP BY al.artist_mbid
       ORDER BY name COLLATE NOCASE`,
    )
    .all(...search.params) as {
    artist_mbid: string;
    name: string;
    lidarr_id: number | null;
    monitored: number;
    size_on_disk: number;
    total: number;
    downloaded: number;
    missing: number;
    partial: number;
    cutoff: number;
    cover_url: string | null;
  }[];
  return rows.map((r) => ({
    artistMbid: r.artist_mbid,
    name: r.name,
    lidarrId: r.lidarr_id,
    monitored: r.monitored === 1,
    total: r.total,
    downloaded: r.downloaded ?? 0,
    missing: r.missing ?? 0,
    partial: r.partial ?? 0,
    cutoff: r.cutoff ?? 0,
    sizeOnDisk: r.size_on_disk ?? 0,
    coverUrl: r.cover_url,
  }));
}

export function libraryCounts(): Omit<LibraryStats, 'lastSyncAt' | 'lastSyncError' | 'syncing' | 'lidarrConfigured'> {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(al.status = 'downloaded'), 0) AS downloaded,
         COALESCE(SUM(${MISSING_SQL}), 0) AS missing,
         COALESCE(SUM(al.cutoff_unmet = 1), 0) AS cutoff,
         COALESCE(SUM(al.monitored = 0), 0) AS unmonitored,
         COALESCE(SUM(r.user_rating >= 4), 0) AS favorites
       FROM library_albums al LEFT JOIN ratings r ON r.album_mbid = al.album_mbid`,
    )
    .get() as Record<string, number>;
  const artists = (db.prepare('SELECT COUNT(*) AS n FROM library_artists').get() as { n: number }).n;
  return {
    total: row.total,
    downloaded: row.downloaded,
    missing: row.missing,
    cutoff: row.cutoff,
    unmonitored: row.unmonitored,
    favorites: row.favorites,
    artists,
  };
}

/** Optimistically mark albums as monitored/wanted right after sending them to Lidarr. */
export function markAlbumsRequested(
  albums: { mbid: string; title: string; artistMbid: string; artistName: string; year: number | null; primaryType: string | null; secondaryTypes: string[] }[],
  searched: boolean,
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO library_albums (album_mbid, lidarr_album_id, artist_mbid, artist_name, title, year, primary_type,
      secondary_types, monitored, status, percent_of_tracks, cutoff_unmet, cover_url, last_searched_at, updated_at)
    VALUES (@mbid, NULL, @artistMbid, @artistName, @title, @year, @primaryType, @secondaryTypes, 1, 'missing_monitored',
      0, 0, NULL, @searchedAt, @now)
    ON CONFLICT(album_mbid) DO UPDATE SET
      monitored = 1,
      status = CASE WHEN library_albums.status IN ('downloaded', 'partial') THEN library_albums.status ELSE 'missing_monitored' END,
      last_searched_at = COALESCE(@searchedAt, library_albums.last_searched_at),
      updated_at = @now
  `);
  db.transaction(() => {
    for (const a of albums) {
      stmt.run({
        mbid: a.mbid,
        artistMbid: a.artistMbid,
        artistName: a.artistName,
        title: a.title,
        year: a.year,
        primaryType: a.primaryType ?? 'Album',
        secondaryTypes: a.secondaryTypes.join(','),
        searchedAt: searched ? now : null,
        now,
      });
    }
  })();
}
