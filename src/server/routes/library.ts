import { Router } from 'express';
import { db } from '../db.js';
import { clearDripQueue, enqueueAlbums, enqueueAllMissing, getDripStatus, setDripPaused } from '../drip.js';
import { ApiError, ah } from '../http.js';
import { lidarrConfigured } from '../lidarr.js';
import { libraryCounts, parseFilter, queryLibraryAlbums, queryLibraryArtists, type LibrarySort } from '../library.js';
import { isSyncing, lastSyncInfo, syncLibrary } from '../sync.js';
import type { LibraryStats, RatingUpdate } from '../../shared/types.js';

export const libraryRouter = Router();

const SORTS: LibrarySort[] = ['artist', 'newest', 'oldest', 'title', 'searched'];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

libraryRouter.get('/library/albums', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sort = SORTS.includes(req.query.sort as LibrarySort) ? (req.query.sort as LibrarySort) : 'artist';
  res.json(
    queryLibraryAlbums({
      q: str(req.query.q).slice(0, 200),
      filter: parseFilter(req.query.filter),
      artistMbid: str(req.query.artistMbid) || undefined,
      sort,
      limit,
      offset,
    }),
  );
});

libraryRouter.get('/library/artists', (req, res) => {
  res.json({ items: queryLibraryArtists(str(req.query.q).slice(0, 200), parseFilter(req.query.filter)) });
});

function buildStats(): LibraryStats {
  return { ...libraryCounts(), ...lastSyncInfo(), syncing: isSyncing(), lidarrConfigured: lidarrConfigured() };
}

libraryRouter.get('/library/stats', (_req, res) => {
  res.json(buildStats());
});

libraryRouter.post(
  '/library/sync',
  ah(async (_req, res) => {
    const result = await syncLibrary();
    res.json({ result, stats: buildStats() });
  }),
);

// ---------------------------------------------------------------------------
// Ratings (feed the AI taste profile)
// ---------------------------------------------------------------------------

libraryRouter.get('/ratings', (req, res) => {
  const min = Math.min(5, Math.max(1, Number(req.query.min) || 1));
  const rows = db
    .prepare(
      `SELECT album_mbid AS albumMbid, artist_name AS artistName, album_title AS albumTitle, year,
              user_rating AS userRating, community_rating AS communityRating, updated_at AS updatedAt
       FROM ratings WHERE user_rating >= ? ORDER BY user_rating DESC, updated_at DESC`,
    )
    .all(min);
  res.json({ items: rows });
});

libraryRouter.put('/ratings/:mbid', (req, res) => {
  const { mbid } = req.params;
  const body = (req.body ?? {}) as Partial<RatingUpdate>;
  const rating = body.rating === null || body.rating === 0 ? null : Number(body.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new ApiError(400, 'Rating must be an integer from 1 to 5, or null to clear.');
  }
  if (rating === null) {
    db.prepare('DELETE FROM ratings WHERE album_mbid = ?').run(mbid);
    res.json({ ok: true, rating: null });
    return;
  }
  const library = db.prepare('SELECT artist_name, title, year FROM library_albums WHERE album_mbid = ?').get(mbid) as
    | { artist_name: string; title: string; year: number | null }
    | undefined;
  db.prepare(
    `INSERT INTO ratings (album_mbid, artist_name, album_title, year, user_rating, community_rating, updated_at)
     VALUES (@mbid, @artist, @title, @year, @rating, @community, @now)
     ON CONFLICT(album_mbid) DO UPDATE SET
       artist_name = excluded.artist_name, album_title = excluded.album_title, year = excluded.year,
       user_rating = excluded.user_rating,
       community_rating = COALESCE(excluded.community_rating, ratings.community_rating),
       updated_at = excluded.updated_at`,
  ).run({
    mbid,
    artist: String(body.artistName || library?.artist_name || 'Unknown Artist').slice(0, 300),
    title: String(body.albumTitle || library?.title || 'Unknown Album').slice(0, 300),
    year: typeof body.year === 'number' ? body.year : (library?.year ?? null),
    rating,
    community: typeof body.communityRating === 'number' ? body.communityRating : null,
    now: Date.now(),
  });
  res.json({ ok: true, rating });
});

// ---------------------------------------------------------------------------
// Drip queue
// ---------------------------------------------------------------------------

libraryRouter.get('/drip/status', (_req, res) => {
  res.json(getDripStatus());
});

libraryRouter.post('/drip/enqueue', (req, res) => {
  if (!lidarrConfigured()) throw new ApiError(400, 'Lidarr is not configured.');
  const { albumMbids, ignoreCooldown } = (req.body ?? {}) as { albumMbids?: string[]; ignoreCooldown?: boolean };
  if (!Array.isArray(albumMbids) || albumMbids.length === 0) throw new ApiError(400, 'Select at least one album.');
  const result = enqueueAlbums(albumMbids.filter((m) => typeof m === 'string').slice(0, 5000), Boolean(ignoreCooldown));
  res.json({ ...result, status: getDripStatus() });
});

libraryRouter.post('/drip/enqueue-all-missing', (req, res) => {
  if (!lidarrConfigured()) throw new ApiError(400, 'Lidarr is not configured.');
  const { includeCutoff } = (req.body ?? {}) as { includeCutoff?: boolean };
  const result = enqueueAllMissing(Boolean(includeCutoff));
  res.json({ ...result, status: getDripStatus() });
});

libraryRouter.post('/drip/pause', (req, res) => {
  const { paused } = (req.body ?? {}) as { paused?: boolean };
  setDripPaused(Boolean(paused));
  res.json(getDripStatus());
});

libraryRouter.post('/drip/clear', (_req, res) => {
  const removed = clearDripQueue();
  res.json({ removed, status: getDripStatus() });
});
