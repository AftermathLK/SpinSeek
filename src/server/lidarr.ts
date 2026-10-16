import { getSetting } from './db.js';
import { ApiError, fetchJson } from './http.js';
import { getSecret } from './secrets.js';
import type { LidarrProfiles, MetadataProfileSummary } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Lidarr API v1 resource shapes (only the fields Spin Seek uses)
// ---------------------------------------------------------------------------

export interface LidarrImage {
  coverType: string;
  url?: string;
  remoteUrl?: string;
}

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored: boolean;
  monitorNewItems?: string;
  metadataProfileId: number;
  qualityProfileId: number;
  rootFolderPath?: string;
  path?: string;
  images?: LidarrImage[];
  statistics?: { albumCount?: number; trackFileCount?: number; sizeOnDisk?: number };
  [key: string]: unknown;
}

export interface LidarrRelease {
  id: number;
  foreignReleaseId: string;
  title: string;
  status?: string;
  trackCount?: number;
  mediumCount?: number;
  media?: { mediumNumber?: number; mediumName?: string; mediumFormat?: string }[];
  disambiguation?: string;
  country?: string[];
  format?: string;
  monitored: boolean;
  [key: string]: unknown;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  anyReleaseOk?: boolean;
  releases?: LidarrRelease[];
  albumType: string;
  secondaryTypes?: { id?: number; name: string }[];
  releaseDate?: string;
  lastSearchTime?: string | null;
  images?: LidarrImage[];
  statistics?: {
    trackFileCount?: number;
    trackCount?: number;
    totalTrackCount?: number;
    sizeOnDisk?: number;
    percentOfTracks?: number;
  };
  artist?: LidarrArtist;
  [key: string]: unknown;
}

interface LidarrMetadataProfile {
  id: number;
  name: string;
  primaryAlbumTypes: { albumType: { id: number; name: string }; allowed: boolean }[];
  secondaryAlbumTypes: { albumType: { id: number; name: string }; allowed: boolean }[];
}

interface Paged<T> {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: T[];
}

export interface LidarrQueueRecord {
  id: number;
  artistId?: number;
  albumId?: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  protocol?: string;
  downloadClient?: string;
  errorMessage?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  artist?: { artistName?: string };
  album?: { title?: string };
}

// ---------------------------------------------------------------------------

export interface LidarrConnection {
  url: string;
  apiKey: string;
}

export function getConnection(): LidarrConnection | null {
  const url = getSetting('lidarr_url').trim().replace(/\/+$/, '');
  const apiKey = getSecret('lidarr_api_key');
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

export function lidarrConfigured(): boolean {
  return getConnection() !== null;
}

function requireConnection(): LidarrConnection {
  const conn = getConnection();
  if (!conn) throw new ApiError(400, 'Lidarr is not configured. Add the URL and API key in Settings.');
  return conn;
}

export async function lidarrRequest<T>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; conn?: LidarrConnection; hideDetail?: boolean } = {},
): Promise<T> {
  const conn = opts.conn ?? requireConnection();
  return fetchJson<T>(`${conn.url}${path}`, {
    service: 'Lidarr',
    method: opts.method,
    body: opts.body,
    headers: { 'X-Api-Key': conn.apiKey },
    timeoutMs: opts.timeoutMs ?? 20000,
    hideDetail: opts.hideDetail,
  });
}

export async function getSystemStatus(conn?: LidarrConnection): Promise<{ version: string; appName?: string; instanceName?: string }> {
  return lidarrRequest('/api/v1/system/status', { conn, timeoutMs: 10000, hideDetail: true });
}

// ---------------------------------------------------------------------------
// Profiles (cached briefly; used by dropdowns and the metadata-profile trap guard)
// ---------------------------------------------------------------------------

let profileCache: { at: number; data: LidarrProfiles } | null = null;
const PROFILE_TTL_MS = 5 * 60 * 1000;

export function invalidateProfileCache(): void {
  profileCache = null;
}

function summarizeMetadataProfile(p: LidarrMetadataProfile): MetadataProfileSummary {
  return {
    id: p.id,
    name: p.name,
    primaryTypes: (p.primaryAlbumTypes ?? []).filter((t) => t.allowed).map((t) => t.albumType.name),
    secondaryTypes: (p.secondaryAlbumTypes ?? []).filter((t) => t.allowed).map((t) => t.albumType.name),
  };
}

export async function getProfiles(force = false): Promise<LidarrProfiles> {
  if (!force && profileCache && Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.data;
  const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
    lidarrRequest<{ id: number; path: string; freeSpace?: number }[]>('/api/v1/rootfolder'),
    lidarrRequest<{ id: number; name: string }[]>('/api/v1/qualityprofile'),
    lidarrRequest<LidarrMetadataProfile[]>('/api/v1/metadataprofile'),
  ]);
  const data: LidarrProfiles = {
    rootFolders: (rootFolders ?? []).map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace ?? null })),
    qualityProfiles: (qualityProfiles ?? []).map((q) => ({ id: q.id, name: q.name })),
    metadataProfiles: (metadataProfiles ?? []).map(summarizeMetadataProfile),
  };
  profileCache = { at: Date.now(), data };
  return data;
}

/**
 * Mirrors Lidarr's metadata profile filter: the primary type must be allowed, an album with
 * no secondary types needs "Studio", and every secondary type must be allowed.
 */
export function missingTypesForProfile(
  profile: MetadataProfileSummary,
  primaryType: string | null,
  secondaryTypes: string[],
): string[] {
  const missing: string[] = [];
  const primary = primaryType || 'Album';
  const allowedPrimary = new Set(profile.primaryTypes.map((t) => t.toLowerCase()));
  const allowedSecondary = new Set(profile.secondaryTypes.map((t) => t.toLowerCase()));
  if (!allowedPrimary.has(primary.toLowerCase())) missing.push(primary);
  if (secondaryTypes.length === 0) {
    if (!allowedSecondary.has('studio')) missing.push('Studio');
  } else {
    for (const s of secondaryTypes) {
      if (!allowedSecondary.has(s.toLowerCase())) missing.push(s);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export async function getArtists(): Promise<LidarrArtist[]> {
  return (await lidarrRequest<LidarrArtist[]>('/api/v1/artist', { timeoutMs: 120000 })) ?? [];
}

export async function getArtist(id: number): Promise<LidarrArtist> {
  return lidarrRequest<LidarrArtist>(`/api/v1/artist/${id}`);
}

export async function getAllAlbums(): Promise<LidarrAlbum[]> {
  return (await lidarrRequest<LidarrAlbum[]>('/api/v1/album', { timeoutMs: 180000 })) ?? [];
}

export async function getAlbumsByArtist(artistId: number): Promise<LidarrAlbum[]> {
  return (await lidarrRequest<LidarrAlbum[]>(`/api/v1/album?artistId=${artistId}`, { timeoutMs: 60000 })) ?? [];
}

export async function getCutoffUnmetIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  const pageSize = 500;
  for (let page = 1; page <= 200; page++) {
    const data = await lidarrRequest<Paged<{ id: number }>>(
      `/api/v1/wanted/cutoff?page=${page}&pageSize=${pageSize}&monitored=true&includeArtist=false`,
      { timeoutMs: 120000 },
    );
    const records = data?.records ?? [];
    for (const r of records) ids.add(r.id);
    if (records.length < pageSize || ids.size >= (data?.totalRecords ?? 0)) break;
  }
  return ids;
}

export async function getQueue(): Promise<Paged<LidarrQueueRecord>> {
  return lidarrRequest<Paged<LidarrQueueRecord>>(
    '/api/v1/queue?page=1&pageSize=50&includeUnknownArtistItems=true&includeArtist=true&includeAlbum=true',
    { timeoutMs: 10000 },
  );
}

// ---------------------------------------------------------------------------
// Adding & monitoring
// ---------------------------------------------------------------------------

export async function lookupArtist(artistMbid: string): Promise<LidarrArtist | null> {
  const results = await lidarrRequest<LidarrArtist[]>(
    `/api/v1/artist/lookup?term=${encodeURIComponent(`lidarr:${artistMbid}`)}`,
    { timeoutMs: 60000 },
  );
  return results?.find((a) => a.foreignArtistId === artistMbid) ?? results?.[0] ?? null;
}

export async function addArtist(body: Record<string, unknown>): Promise<LidarrArtist> {
  return lidarrRequest<LidarrArtist>('/api/v1/artist', { method: 'POST', body, timeoutMs: 60000 });
}

export async function updateArtist(artist: LidarrArtist): Promise<LidarrArtist> {
  return lidarrRequest<LidarrArtist>(`/api/v1/artist/${artist.id}`, { method: 'PUT', body: artist, timeoutMs: 60000 });
}

export async function lookupAlbum(albumMbid: string): Promise<LidarrAlbum | null> {
  const results = await lidarrRequest<LidarrAlbum[]>(
    `/api/v1/album/lookup?term=${encodeURIComponent(`lidarr:${albumMbid}`)}`,
    { timeoutMs: 60000 },
  );
  return results?.find((a) => a.foreignAlbumId === albumMbid) ?? results?.[0] ?? null;
}

export async function addAlbum(body: Record<string, unknown>): Promise<LidarrAlbum> {
  return lidarrRequest<LidarrAlbum>('/api/v1/album', { method: 'POST', body, timeoutMs: 60000 });
}

export async function getAlbum(id: number): Promise<LidarrAlbum> {
  return lidarrRequest<LidarrAlbum>(`/api/v1/album/${id}`, { timeoutMs: 30000 });
}

export async function updateAlbum(album: LidarrAlbum): Promise<LidarrAlbum> {
  return lidarrRequest<LidarrAlbum>(`/api/v1/album/${album.id}`, { method: 'PUT', body: album, timeoutMs: 30000 });
}

export interface LidarrCommand {
  id: number;
  name: string;
  status: string;
  body?: { artistId?: number; artistIds?: number[] };
}

/** True while Lidarr is still importing/refreshing this artist (releases may still change). */
export async function isArtistRefreshing(artistId: number): Promise<boolean> {
  const commands = (await lidarrRequest<LidarrCommand[]>('/api/v1/command', { timeoutMs: 15000 })) ?? [];
  // Only commands scoped to this artist: global tasks (RefreshMonitoredDownloads, …) run constantly.
  return commands.some(
    (c) =>
      (c.status === 'queued' || c.status === 'started') &&
      /refresh|rescan/i.test(c.name) &&
      (c.body?.artistId === artistId || Boolean(c.body?.artistIds?.includes(artistId))),
  );
}

export async function monitorAlbums(albumIds: number[], monitored: boolean): Promise<void> {
  if (albumIds.length === 0) return;
  await lidarrRequest('/api/v1/album/monitor', { method: 'PUT', body: { albumIds, monitored } });
}

export async function runCommand(name: string, body: Record<string, unknown>): Promise<{ id: number }> {
  return lidarrRequest<{ id: number }>('/api/v1/command', { method: 'POST', body: { name, ...body } });
}

export function coverFromImages(images: LidarrImage[] | undefined): string | null {
  const cover = images?.find((i) => i.coverType === 'cover') ?? images?.find((i) => i.coverType === 'poster');
  const remote = cover?.remoteUrl;
  return remote && /^https?:\/\//i.test(remote) ? remote : null;
}
