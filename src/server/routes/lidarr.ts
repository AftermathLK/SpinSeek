import { Router } from 'express';
import { ApiError, ah, errorMessage } from '../http.js';
import { getQueue, lidarrConfigured } from '../lidarr.js';
import { addToLidarr, preflight, validateAlbums } from '../lidarrAdd.js';
import { selectStandardEditions } from '../releaseSelect.js';
import type { AddRequest, LidarrQueueResponse } from '../../shared/types.js';

export const lidarrRouter = Router();

/** Active grabs/downloads for the Live Activity pill. Never errors: reports problems inline. */
lidarrRouter.get(
  '/lidarr/queue',
  ah(async (_req, res) => {
    if (!lidarrConfigured()) {
      res.json({ configured: false, total: 0, items: [], error: null } satisfies LidarrQueueResponse);
      return;
    }
    try {
      const data = await getQueue();
      const items = (data?.records ?? []).map((r) => {
        const size = r.size ?? 0;
        const left = r.sizeleft ?? 0;
        const messages = (r.statusMessages ?? []).flatMap((m) => m.messages ?? []).filter(Boolean);
        return {
          id: r.id,
          title: r.title ?? 'Unknown release',
          artistName: r.artist?.artistName ?? null,
          albumTitle: r.album?.title ?? null,
          status: r.status ?? 'unknown',
          trackedDownloadState: r.trackedDownloadState ?? null,
          progress: size > 0 ? Math.min(100, Math.max(0, ((size - left) / size) * 100)) : 0,
          size,
          sizeLeft: left,
          timeLeft: r.timeleft ?? null,
          protocol: r.protocol ?? null,
          downloadClient: r.downloadClient ?? null,
          errorMessage: r.errorMessage || messages[0] || null,
        };
      });
      res.json({ configured: true, total: data?.totalRecords ?? items.length, items, error: null } satisfies LidarrQueueResponse);
    } catch (err) {
      res.json({ configured: true, total: 0, items: [], error: errorMessage(err) } satisfies LidarrQueueResponse);
    }
  }),
);

lidarrRouter.post(
  '/lidarr/preflight',
  ah(async (req, res) => {
    const body = (req.body ?? {}) as { albums?: unknown; metadataProfileId?: unknown };
    const albums = validateAlbums(body.albums);
    const profileId = Number(body.metadataProfileId);
    if (!Number.isFinite(profileId) || profileId <= 0) throw new ApiError(400, 'Choose a metadata profile.');
    res.json(await preflight(albums, profileId));
  }),
);

/** Library bulk action: monitor the standard edition (preferred country) for albums already in Lidarr. */
lidarrRouter.post(
  '/lidarr/select-release',
  ah(async (req, res) => {
    if (!lidarrConfigured()) throw new ApiError(400, 'Lidarr is not configured.');
    const { albumMbids } = (req.body ?? {}) as { albumMbids?: unknown };
    if (!Array.isArray(albumMbids) || albumMbids.length === 0) throw new ApiError(400, 'Select at least one album.');
    const mbids = albumMbids.filter((m): m is string => typeof m === 'string').slice(0, 500);
    res.json(await selectStandardEditions(mbids));
  }),
);

lidarrRouter.post(
  '/lidarr/add',
  ah(async (req, res) => {
    const body = (req.body ?? {}) as Partial<AddRequest>;
    const request: AddRequest = {
      albums: validateAlbums(body.albums),
      rootFolderPath: String(body.rootFolderPath ?? '').trim(),
      qualityProfileId: Number(body.qualityProfileId),
      metadataProfileId: Number(body.metadataProfileId),
      monitorEntireArtist: Boolean(body.monitorEntireArtist),
      usePermissiveProfile: Boolean(body.usePermissiveProfile),
    };
    res.json(await addToLidarr(request));
  }),
);
