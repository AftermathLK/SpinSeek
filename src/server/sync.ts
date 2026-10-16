import { SYNC_INTERVAL_MS } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { ApiError, UpstreamError, errorMessage } from './http.js';
import {
  coverFromImages,
  getAlbumsByArtist,
  getAllAlbums,
  getArtist,
  getArtists,
  getCutoffUnmetIds,
  lidarrConfigured,
  type LidarrAlbum,
  type LidarrArtist,
} from './lidarr.js';
import { yearFromDate } from './text.js';
import type { LidarrStatus, SyncResult } from '../shared/types.js';

export function computeStatus(album: LidarrAlbum): Exclude<LidarrStatus, 'not_in_lidarr'> {
  const stats = album.statistics ?? {};
  const files = stats.trackFileCount ?? 0;
  const tracks = stats.trackCount ?? stats.totalTrackCount ?? 0;
  const percent = stats.percentOfTracks ?? (tracks > 0 ? (files / tracks) * 100 : 0);
  if (files > 0 && (percent >= 100 || (tracks > 0 && files >= tracks))) return 'downloaded';
  if (files > 0) return 'partial';
  return album.monitored ? 'missing_monitored' : 'unmonitored';
}

const upsertArtistStmt = db.prepare(`
  INSERT INTO library_artists (artist_mbid, lidarr_id, name, monitored, album_count, track_file_count, size_on_disk, updated_at)
  VALUES (@artist_mbid, @lidarr_id, @name, @monitored, @album_count, @track_file_count, @size_on_disk, @updated_at)
  ON CONFLICT(artist_mbid) DO UPDATE SET
    lidarr_id = excluded.lidarr_id, name = excluded.name, monitored = excluded.monitored,
    album_count = excluded.album_count, track_file_count = excluded.track_file_count,
    size_on_disk = excluded.size_on_disk, updated_at = excluded.updated_at
`);

const upsertAlbumStmt = db.prepare(`
  INSERT INTO library_albums (album_mbid, lidarr_album_id, artist_mbid, artist_name, title, year, primary_type,
    secondary_types, monitored, status, percent_of_tracks, cutoff_unmet, cover_url, last_searched_at, updated_at)
  VALUES (@album_mbid, @lidarr_album_id, @artist_mbid, @artist_name, @title, @year, @primary_type,
    @secondary_types, @monitored, @status, @percent_of_tracks, @cutoff_unmet, @cover_url, @last_searched_at, @updated_at)
  ON CONFLICT(album_mbid) DO UPDATE SET
    lidarr_album_id = excluded.lidarr_album_id, artist_mbid = excluded.artist_mbid, artist_name = excluded.artist_name,
    title = excluded.title, year = excluded.year, primary_type = excluded.primary_type,
    secondary_types = excluded.secondary_types, monitored = excluded.monitored, status = excluded.status,
    percent_of_tracks = excluded.percent_of_tracks,
    cutoff_unmet = COALESCE(excluded.cutoff_unmet, library_albums.cutoff_unmet, 0),
    cover_url = excluded.cover_url,
    last_searched_at = NULLIF(MAX(COALESCE(library_albums.last_searched_at, 0), COALESCE(excluded.last_searched_at, 0)), 0),
    updated_at = excluded.updated_at
`);

function artistRow(artist: LidarrArtist, now: number) {
  return {
    artist_mbid: artist.foreignArtistId,
    lidarr_id: artist.id,
    name: artist.artistName,
    monitored: artist.monitored ? 1 : 0,
    album_count: artist.statistics?.albumCount ?? 0,
    track_file_count: artist.statistics?.trackFileCount ?? 0,
    size_on_disk: artist.statistics?.sizeOnDisk ?? 0,
    updated_at: now,
  };
}

/** cutoffIds === null keeps the existing cutoff_unmet flag (partial refreshes). */
function albumRow(album: LidarrAlbum, artist: LidarrArtist | undefined, cutoffIds: Set<number> | null, now: number) {
  const lastSearch = album.lastSearchTime ? Date.parse(album.lastSearchTime) : NaN;
  const status = computeStatus(album);
  return {
    album_mbid: album.foreignAlbumId,
    lidarr_album_id: album.id,
    artist_mbid: artist?.foreignArtistId ?? album.artist?.foreignArtistId ?? '',
    artist_name: artist?.artistName ?? album.artist?.artistName ?? 'Unknown Artist',
    title: album.title,
    year: yearFromDate(album.releaseDate),
    primary_type: album.albumType || 'Album',
    secondary_types: (album.secondaryTypes ?? []).map((s) => s.name).join(','),
    monitored: album.monitored ? 1 : 0,
    status,
    percent_of_tracks: album.statistics?.percentOfTracks ?? 0,
    cutoff_unmet: cutoffIds ? (cutoffIds.has(album.id) ? 1 : 0) : status === 'downloaded' ? null : 0,
    cover_url: coverFromImages(album.images),
    last_searched_at: Number.isFinite(lastSearch) && lastSearch > 0 ? lastSearch : null,
    updated_at: now,
  };
}

let running: Promise<SyncResult> | null = null;

export function isSyncing(): boolean {
  return running !== null;
}

/** Full sync: artists + albums + cutoff-unmet into SQLite. Concurrent callers share one run. */
export function syncLibrary(): Promise<SyncResult> {
  if (running) return running;
  running = doFullSync().finally(() => {
    running = null;
  });
  return running;
}

async function doFullSync(): Promise<SyncResult> {
  if (!lidarrConfigured()) throw new ApiError(400, 'Lidarr is not configured. Add the URL and API key in Settings.');
  const started = Date.now();
  try {
    const [artists, albums, cutoffIds] = await Promise.all([getArtists(), getAllAlbums(), getCutoffUnmetIds()]);
    const artistsById = new Map(artists.map((a) => [a.id, a]));
    const now = Date.now();
    const write = db.transaction(() => {
      for (const artist of artists) {
        if (artist.foreignArtistId) upsertArtistStmt.run(artistRow(artist, now));
      }
      for (const album of albums) {
        if (!album.foreignAlbumId) continue;
        upsertAlbumStmt.run(albumRow(album, artistsById.get(album.artistId), cutoffIds, now));
      }
      db.prepare('DELETE FROM library_artists WHERE updated_at < ?').run(now);
      db.prepare('DELETE FROM library_albums WHERE updated_at < ?').run(now);
    });
    write();
    setSetting('last_sync_at', String(Date.now()));
    setSetting('last_sync_error', '');
    const result: SyncResult = {
      artists: artists.length,
      albums: albums.length,
      cutoffUnmet: cutoffIds.size,
      durationMs: Date.now() - started,
    };
    console.log(
      `[sync] ${result.artists} artists, ${result.albums} albums, ${result.cutoffUnmet} cutoff unmet (${result.durationMs}ms)`,
    );
    return result;
  } catch (err) {
    setSetting('last_sync_error', errorMessage(err));
    throw err;
  }
}

/** Targeted refresh of one artist (webhooks, post-add). */
export async function syncArtist(lidarrArtistId: number): Promise<void> {
  if (!lidarrConfigured()) return;
  let artist: LidarrArtist;
  try {
    artist = await getArtist(lidarrArtistId);
  } catch (err) {
    if (err instanceof UpstreamError && err.upstreamStatus === 404) {
      // Artist was deleted in Lidarr.
      removeArtistLocally(lidarrArtistId);
      return;
    }
    throw err;
  }
  const albums = await getAlbumsByArtist(lidarrArtistId);
  const now = Date.now();
  db.transaction(() => {
    upsertArtistStmt.run(artistRow(artist, now));
    for (const album of albums) {
      if (album.foreignAlbumId) upsertAlbumStmt.run(albumRow(album, artist, null, now));
    }
    db.prepare('DELETE FROM library_albums WHERE artist_mbid = ? AND updated_at < ?').run(artist.foreignArtistId, now);
  })();
}

export function removeArtistLocally(lidarrArtistId: number): void {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM library_albums WHERE artist_mbid = (SELECT artist_mbid FROM library_artists WHERE lidarr_id = ?)',
    ).run(lidarrArtistId);
    db.prepare('DELETE FROM library_artists WHERE lidarr_id = ?').run(lidarrArtistId);
  })();
}

const pendingArtistRefresh = new Map<number, NodeJS.Timeout>();

/** Debounced per-artist refresh so bursts of webhook events cause one Lidarr round-trip. */
export function scheduleArtistRefresh(lidarrArtistId: number, delayMs = 5000): void {
  const existing = pendingArtistRefresh.get(lidarrArtistId);
  if (existing) clearTimeout(existing);
  pendingArtistRefresh.set(
    lidarrArtistId,
    setTimeout(() => {
      pendingArtistRefresh.delete(lidarrArtistId);
      syncArtist(lidarrArtistId).catch((err) => console.warn(`[sync] artist refresh failed: ${errorMessage(err)}`));
    }, delayMs),
  );
}

let followUpTimers: NodeJS.Timeout[] = [];

/** After adding new artists Lidarr imports metadata asynchronously; re-sync a couple of times. */
export function scheduleFollowUpSyncs(delaysMs: number[] = [45000, 180000]): void {
  for (const t of followUpTimers) clearTimeout(t);
  followUpTimers = delaysMs.map((d) =>
    setTimeout(() => {
      syncLibrary().catch((err) => console.warn(`[sync] follow-up sync failed: ${errorMessage(err)}`));
    }, d),
  );
}

export function startSyncScheduler(): void {
  const run = () => {
    if (!lidarrConfigured()) return;
    syncLibrary().catch((err) => console.warn(`[sync] scheduled sync failed: ${errorMessage(err)}`));
  };
  setTimeout(run, 8000);
  setInterval(run, SYNC_INTERVAL_MS);
}

export function lastSyncInfo(): { lastSyncAt: number | null; lastSyncError: string | null } {
  const at = Number(getSetting('last_sync_at'));
  const error = getSetting('last_sync_error');
  return { lastSyncAt: at > 0 ? at : null, lastSyncError: error || null };
}
