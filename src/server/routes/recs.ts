import { Router } from 'express';
import { requireFeature } from '../features.js';
import { ApiError, ah, startNdjson } from '../http.js';
import { lastfmConfigured } from '../lastfm.js';
import { runRecs, similarArtistsFor } from '../recs.js';
import type { RecsMode, RecsRequest } from '../../shared/types.js';

export const recsRouter = Router();

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: RecsMode[] = ['foryou', 'similar', 'scrobbles'];

function requireLastfm(): void {
  requireFeature('recs');
  if (!lastfmConfigured()) throw new ApiError(400, 'Add your Last.fm API key in Settings → Last.fm.');
}

/** 📻 Recommendations, streamed as NDJSON like AI Discovery. */
recsRouter.post(
  '/recs/stream',
  ah(async (req, res) => {
    requireLastfm();
    const body = (req.body ?? {}) as Partial<RecsRequest>;
    if (!MODES.includes(body.mode as RecsMode)) throw new ApiError(400, 'Unknown recommendation mode.');
    const request: RecsRequest = {
      mode: body.mode as RecsMode,
      artist: typeof body.artist === 'string' ? body.artist.slice(0, 200) : undefined,
      period: body.period,
      excludeSeeds: Array.isArray(body.excludeSeeds) ? body.excludeSeeds.filter((s) => typeof s === 'string').slice(0, 200) : [],
      shuffle: Boolean(body.shuffle),
    };
    const stream = startNdjson(res);
    try {
      await runRecs(request, stream);
    } finally {
      stream.end();
    }
  }),
);

/** Artist page "Similar Artists" row. */
recsRouter.get(
  '/artist/:mbid/similar',
  ah(async (req, res) => {
    requireLastfm();
    const { mbid } = req.params;
    if (!MBID_RE.test(mbid)) throw new ApiError(400, 'Invalid artist MBID.');
    res.json({ artists: await similarArtistsFor(mbid) });
  }),
);
