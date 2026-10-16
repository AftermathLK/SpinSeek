// Last.fm API (similar artists, top albums, user scrobbles). The endpoint is fixed, so a stored key can
// never be sent anywhere else. LASTFM_API_BASE exists only for offline testing via the environment.
import { cacheGet, cacheSet, getSetting } from './db.js';
import { ApiError, SpacedQueue, UpstreamError, fetchJson } from './http.js';
import { getSecret } from './secrets.js';
import type { LastfmPeriod } from '../shared/types.js';

const LASTFM_BASE = process.env.LASTFM_API_BASE?.trim() || 'https://ws.audioscrobbler.com/2.0/';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Last.fm asks for at most ~5 requests/second. */
const queue = new SpacedQueue(220);

export function lastfmConfigured(): boolean {
  return getSecret('lastfm_api_key').length > 0;
}

export function lastfmUsername(): string {
  return getSetting('lastfm_username').trim();
}

interface LastfmError {
  error?: number;
  message?: string;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Error 6 ("not found") is a normal empty result; auth/key errors are surfaced cleanly. */
async function call<T>(method: string, params: Record<string, string>, ttlMs: number, apiKey?: string): Promise<T | null> {
  const key = apiKey ?? getSecret('lastfm_api_key');
  if (!key) throw new ApiError(400, 'Add your Last.fm API key in Settings → Last.fm.');
  const cacheKey = `lastfm:${method}:${JSON.stringify(params)}`;
  if (!apiKey) {
    const cached = cacheGet<T>(cacheKey);
    if (cached !== undefined) return cached;
  }
  const qs = new URLSearchParams({ method, ...params, api_key: key, format: 'json' });
  let data: (T & LastfmError) | undefined;
  try {
    data = await queue.run(() => fetchJson<T & LastfmError>(`${LASTFM_BASE}?${qs}`, { service: 'Last.fm', timeoutMs: 12000, hideDetail: true }));
  } catch (err) {
    // Last.fm also signals errors with HTTP status codes: 404 = not found (empty result), 403 = bad key.
    if (err instanceof UpstreamError && err.upstreamStatus === 404) return null;
    if (err instanceof UpstreamError && err.upstreamStatus === 403) throw new UpstreamError(502, 'Last.fm: invalid API key', 403);
    throw err;
  }
  if (data?.error) {
    if (data.error === 6) return null;
    if (data.error === 10 || data.error === 26) throw new UpstreamError(502, 'Last.fm: invalid API key', 200);
    if (data.error === 29) throw new UpstreamError(502, 'Last.fm: rate limited, try again in a minute', 200);
    throw new UpstreamError(502, `Last.fm: error ${data.error}`, 200);
  }
  if (!apiKey) cacheSet(cacheKey, data, ttlMs);
  return data;
}

export interface LastfmArtistRef {
  name: string;
  mbid: string | null;
  /** 0–1 */
  match: number;
}

function mbidOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export async function getSimilarArtists(name: string, mbid: string | null, limit: number): Promise<{ artists: LastfmArtistRef[]; resolvedName: string }> {
  const params: Record<string, string> = mbid ? { mbid, limit: String(limit) } : { artist: name, autocorrect: '1', limit: String(limit) };
  const data = await call<{
    similarartists?: { artist?: { name: string; mbid?: string; match?: string }[]; '@attr'?: { artist?: string } };
  }>('artist.getsimilar', params, DAY_MS);
  const artists = asArray(data?.similarartists?.artist).map((a) => ({
    name: a.name,
    mbid: mbidOrNull(a.mbid),
    match: Math.max(0, Math.min(1, Number(a.match) || 0)),
  }));
  return { artists, resolvedName: data?.similarartists?.['@attr']?.artist || name };
}

export interface LastfmAlbumRef {
  title: string;
  artist: string;
  artistMbid: string | null;
  playcount: number;
}

function validAlbumTitle(title: string | undefined): title is string {
  return Boolean(title && title.trim() && !/^\(null\)$|^undefined$/i.test(title.trim()));
}

export async function getArtistTopAlbums(name: string, mbid: string | null, limit: number): Promise<LastfmAlbumRef[]> {
  const params: Record<string, string> = mbid ? { mbid, limit: String(limit) } : { artist: name, autocorrect: '1', limit: String(limit) };
  const data = await call<{
    topalbums?: { album?: { name: string; playcount?: string | number; artist?: { name?: string; mbid?: string } }[] };
  }>('artist.gettopalbums', params, DAY_MS);
  return asArray(data?.topalbums?.album)
    .filter((a) => validAlbumTitle(a.name))
    .map((a) => ({
      title: a.name,
      artist: a.artist?.name || name,
      artistMbid: mbidOrNull(a.artist?.mbid) ?? mbid,
      playcount: Number(a.playcount) || 0,
    }));
}

export async function getUserTopAlbums(user: string, period: LastfmPeriod, limit: number): Promise<LastfmAlbumRef[]> {
  const data = await call<{
    topalbums?: { album?: { name: string; playcount?: string | number; artist?: { name?: string; mbid?: string } }[] };
  }>('user.gettopalbums', { user, period, limit: String(limit) }, 30 * 60 * 1000);
  if (!data) throw new ApiError(404, `Last.fm user "${user}" was not found.`);
  return asArray(data.topalbums?.album)
    .filter((a) => validAlbumTitle(a.name) && a.artist?.name)
    .map((a) => ({
      title: a.name,
      artist: a.artist?.name ?? '',
      artistMbid: mbidOrNull(a.artist?.mbid),
      playcount: Number(a.playcount) || 0,
    }));
}

/** Settings → Last.fm "Test": validates the key (and the username, if given). */
export async function testLastfm(apiKey: string | undefined, user: string): Promise<{ user: string | null; scrobbles: number | null }> {
  if (user) {
    const data = await call<{ user?: { name?: string; playcount?: string } }>('user.getinfo', { user }, 0, apiKey);
    if (!data?.user) throw new ApiError(404, `Last.fm user "${user}" was not found.`);
    return { user: data.user.name ?? user, scrobbles: Number(data.user.playcount) || 0 };
  }
  await call('artist.getinfo', { artist: 'Radiohead' }, 0, apiKey);
  return { user: null, scrobbles: null };
}
