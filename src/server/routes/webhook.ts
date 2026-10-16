import { Router, type Request } from 'express';
import { safeEqual } from '../auth.js';
import { db } from '../db.js';
import { ApiError, ah } from '../http.js';
import { getSecret } from '../secrets.js';
import { removeArtistLocally, scheduleArtistRefresh } from '../sync.js';

export const webhookRouter = Router();

interface WebhookAlbum {
  id?: number;
  mbId?: string;
  foreignAlbumId?: string;
  title?: string;
}

interface WebhookPayload {
  eventType?: string;
  artist?: { id?: number; name?: string; mbId?: string; foreignArtistId?: string };
  albums?: WebhookAlbum[];
  album?: WebhookAlbum;
  isUpgrade?: boolean;
}

function providedSecret(req: Request): string {
  if (typeof req.query.secret === 'string') return req.query.secret;
  const header = req.header('x-webhook-secret');
  if (header) return header;
  // Lidarr's webhook connection supports Basic auth: accept the secret as the password.
  const auth = req.header('authorization');
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return '';
}

function secretMatches(provided: string): boolean {
  const expected = getSecret('webhook_secret');
  if (!provided || !expected) return false;
  return safeEqual(provided, expected);
}

function albumsOf(payload: WebhookPayload): WebhookAlbum[] {
  return [...(payload.albums ?? []), ...(payload.album ? [payload.album] : [])];
}

function updateAlbums(albums: WebhookAlbum[], sql: string, extra: unknown[] = []): void {
  const byMbid = db.prepare(`UPDATE library_albums SET ${sql}, updated_at = ? WHERE album_mbid = ?`);
  const byId = db.prepare(`UPDATE library_albums SET ${sql}, updated_at = ? WHERE lidarr_album_id = ?`);
  const now = Date.now();
  db.transaction(() => {
    for (const a of albums) {
      const mbid = a.mbId || a.foreignAlbumId;
      if (mbid) byMbid.run(...extra, now, mbid);
      else if (a.id) byId.run(...extra, now, a.id);
    }
  })();
}

/** Lidarr "Connect → Webhook" target: On Grab / On Release Import / artist & album lifecycle events. */
webhookRouter.post(
  '/webhook/lidarr',
  ah(async (req, res) => {
    if (!secretMatches(providedSecret(req))) throw new ApiError(401, 'Invalid webhook secret');
    const payload = (req.body ?? {}) as WebhookPayload;
    const event = payload.eventType ?? 'Unknown';
    const albums = albumsOf(payload);
    const artistId = payload.artist?.id;

    switch (event) {
      case 'Test':
        break;
      case 'Grab':
        // A release was grabbed: the album is definitely monitored and wanted.
        updateAlbums(albums, "monitored = 1, status = CASE WHEN status = 'unmonitored' THEN 'missing_monitored' ELSE status END");
        if (artistId) scheduleArtistRefresh(artistId, 10000);
        break;
      case 'Download':
      case 'AlbumDownload':
      case 'TrackRetag':
      case 'Retag':
      case 'Rename':
        // On Release Import: optimistic update now, exact track statistics after a short delay.
        if (event === 'Download' || event === 'AlbumDownload') {
          updateAlbums(albums, "status = 'downloaded', percent_of_tracks = 100");
          if (payload.isUpgrade) updateAlbums(albums, 'cutoff_unmet = 0');
        }
        if (artistId) scheduleArtistRefresh(artistId, 5000);
        break;
      case 'ArtistAdd':
        if (artistId) scheduleArtistRefresh(artistId, 30000);
        break;
      case 'ArtistDelete':
      case 'ArtistDeleted':
        if (artistId) removeArtistLocally(artistId);
        break;
      case 'AlbumDelete':
      case 'AlbumDeleted': {
        const del = db.prepare('DELETE FROM library_albums WHERE album_mbid = ? OR lidarr_album_id = ?');
        for (const a of albums) del.run(a.mbId || a.foreignAlbumId || '', a.id ?? -1);
        break;
      }
      default:
        if (artistId) scheduleArtistRefresh(artistId, 5000);
    }
    res.json({ ok: true, event });
  }),
);
