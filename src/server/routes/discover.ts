import { Router } from 'express';
import { getAiPicks, requireAiConfig } from '../ai.js';
import { getArtistProfile } from '../artistProfile.js';
import { deezerSuggest, getDeezerInfo, getDeezerPreview } from '../deezer.js';
import { requireFeature } from '../features.js';
import { ApiError, ah, errorMessage, isAbortError, mapPool, startNdjson } from '../http.js';
import { getReleaseGroupEditions, PRIORITY_INTERACTIVE } from '../musicbrainz.js';
import { releaseSettings } from '../releaseSelect.js';
import { resolveAiPick, resolveArtistByMbid, resolveArtistName, resolveQuery } from '../search.js';
import { MAX_BATCH_ITEMS, parseBatchQuery } from '../../shared/parse.js';
import type { AiDiscoverRequest, AiEvent, BatchEvent, DeezerInfo } from '../../shared/types.js';

export const discoverRouter = Router();

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Standard / batch search, streamed as NDJSON so each query renders as soon as it resolves. */
discoverRouter.post(
  '/search/batch',
  ah(async (req, res) => {
    const { query } = (req.body ?? {}) as { query?: string };
    const parsed = parseBatchQuery(typeof query === 'string' ? query : '');
    if (parsed.length === 0) throw new ApiError(400, 'Enter an artist, "Artist - Album", or a list of them.');
    if (parsed.length > MAX_BATCH_ITEMS) throw new ApiError(400, `Batch searches are limited to ${MAX_BATCH_ITEMS} items.`);

    const stream = startNdjson(res);
    const stamp = Date.now().toString(36);
    const items = parsed.map((p, i) => ({ id: `q${stamp}-${i}`, parsed: p }));
    stream.send({
      type: 'start',
      groups: items.map((it) => ({ id: it.id, query: it.parsed.raw, kind: it.parsed.album ? 'album' : 'artist' })),
    } satisfies BatchEvent);
    try {
      // Concurrency 2 keeps results arriving progressively while the MB queue stays saturated.
      await mapPool(items, 2, async (it) => {
        if (stream.closed) return;
        const group = await resolveQuery(it.id, it.parsed, { signal: stream.signal });
        stream.send({ type: 'group', group } satisfies BatchEvent);
      });
      stream.send({ type: 'done' } satisfies BatchEvent);
    } catch (err) {
      if (!isAbortError(err)) stream.send({ type: 'error', error: errorMessage(err) } satisfies BatchEvent);
    } finally {
      stream.end();
    }
  }),
);

/** Re-resolve a group with a specific artist (alternative pick / "show full discography"). */
discoverRouter.post(
  '/search/artist',
  ah(async (req, res) => {
    const { mbid, groupId, query } = (req.body ?? {}) as { mbid?: string; groupId?: string; query?: string };
    if (!mbid || !MBID_RE.test(mbid)) throw new ApiError(400, 'A valid artist MBID is required.');
    const group = await resolveArtistByMbid(groupId || `a-${mbid}`, query || mbid, mbid, { priority: PRIORITY_INTERACTIVE });
    res.json(group);
  }),
);

/** ✨ AI Discovery: Stage 1 (LLM picks) → Stage 2 (parallel MusicBrainz verification), streamed. */
discoverRouter.post(
  '/ai/discover',
  ah(async (req, res) => {
    const body = (req.body ?? {}) as Partial<AiDiscoverRequest>;
    requireFeature('ai');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new ApiError(400, 'Describe what you want to discover.');
    if (prompt.length > 2000) throw new ApiError(400, 'Prompt is too long (max 2000 characters).');
    const count = Math.min(30, Math.max(3, Math.round(Number(body.count) || 12)));
    const includeOwned = Boolean(body.includeOwned);
    const newArtistsOnly = Boolean(body.newArtistsOnly);
    // Fail fast with a plain JSON 400 before switching to streaming.
    requireAiConfig();

    const stream = startNdjson(res);
    try {
      stream.send({ type: 'status', message: 'Asking the AI for recommendations…' } satisfies AiEvent);
      const picks = await getAiPicks(prompt, count, includeOwned, newArtistsOnly);
      if (stream.closed) return;
      stream.send({ type: 'picks', picks } satisfies AiEvent);
      await mapPool(picks, 3, async (pick, index) => {
        if (stream.closed) return;
        try {
          const album = await resolveAiPick(pick, { signal: stream.signal });
          if (album) {
            if (!includeOwned && ['downloaded', 'partial', 'missing_monitored'].includes(album.lidarrStatus)) album.alreadyOwned = true;
            stream.send({ type: 'album', index, album } satisfies AiEvent);
          } else {
            stream.send({
              type: 'unresolved',
              index,
              pick,
              error: 'Not found on MusicBrainz (the AI may have invented this title).',
            } satisfies AiEvent);
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          stream.send({ type: 'unresolved', index, pick, error: errorMessage(err) } satisfies AiEvent);
        }
      });
      stream.send({ type: 'done' } satisfies AiEvent);
    } catch (err) {
      if (!isAbortError(err)) stream.send({ type: 'error', error: errorMessage(err) } satisfies AiEvent);
    } finally {
      stream.end();
    }
  }),
);

/** Live search dropdown (Deezer): top 3 artists + top 3 albums for a single query. */
discoverRouter.get(
  '/search/suggest',
  ah(async (req, res) => {
    requireFeature('autocomplete');
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) {
      res.json({ artists: [], albums: [] });
      return;
    }
    res.json(await deezerSuggest(q));
  }),
);

/** Name → MusicBrainz artist (for "Open Artist Page" from Deezer/Last.fm results). */
discoverRouter.get(
  '/search/resolve-artist',
  ah(async (req, res) => {
    const name = queryString(req.query.name, 'name');
    const artist = await resolveArtistName(name, { priority: PRIORITY_INTERACTIVE });
    if (!artist) throw new ApiError(404, `No MusicBrainz artist found for "${name}".`);
    res.json({ mbid: artist.mbid, name: artist.name });
  }),
);

/** Artist page header: bio, photo, genres, links and library stats. */
discoverRouter.get(
  '/artist/:mbid/profile',
  ah(async (req, res) => {
    const { mbid } = req.params;
    if (!MBID_RE.test(mbid)) throw new ApiError(400, 'Invalid artist MBID.');
    res.json(await getArtistProfile(mbid));
  }),
);

discoverRouter.get(
  '/mb/release-group/:mbid/editions',
  ah(async (req, res) => {
    const { mbid } = req.params;
    if (!MBID_RE.test(mbid)) throw new ApiError(400, 'Invalid release-group MBID.');
    res.json(await getReleaseGroupEditions(mbid, releaseSettings().country));
  }),
);

function queryString(value: unknown, label: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ApiError(400, `${label} is required.`);
  return s.slice(0, 300);
}

discoverRouter.get(
  '/deezer/preview',
  ah(async (req, res) => {
    const preview = await getDeezerPreview(queryString(req.query.artist, 'artist'), queryString(req.query.album, 'album'));
    res.json(preview);
  }),
);

/** Batched Deezer lookups (popularity badge + artwork fallback). */
discoverRouter.post(
  '/deezer/info',
  ah(async (req, res) => {
    const { items } = (req.body ?? {}) as { items?: { key: string; artist: string; album: string }[] };
    if (!Array.isArray(items)) throw new ApiError(400, 'items[] is required.');
    const valid = items
      .filter((i) => i && typeof i.key === 'string' && typeof i.artist === 'string' && typeof i.album === 'string')
      .slice(0, 50);
    const results: Record<string, DeezerInfo | null> = {};
    await mapPool(valid, 4, async (item) => {
      try {
        results[item.key] = await getDeezerInfo(item.artist, item.album);
      } catch {
        results[item.key] = null;
      }
    });
    res.json({ results });
  }),
);

/** <img> fallback when Cover Art Archive has no front cover. */
discoverRouter.get(
  '/deezer/artwork',
  ah(async (req, res) => {
    const info = await getDeezerInfo(queryString(req.query.artist, 'artist'), queryString(req.query.album, 'album'));
    if (!info.coverUrl) throw new ApiError(404, 'No artwork found');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.redirect(302, info.coverUrl);
  }),
);
