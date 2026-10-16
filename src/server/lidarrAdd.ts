import { ApiError, errorMessage } from './http.js';
import { markAlbumsRequested } from './library.js';
import {
  addAlbum,
  addArtist,
  getAlbumsByArtist,
  getArtists,
  getProfiles,
  lookupAlbum,
  lookupArtist,
  missingTypesForProfile,
  monitorAlbums,
  runCommand,
  updateArtist,
  type LidarrArtist,
} from './lidarr.js';
import { applyPreferredRelease, finalizeNewArtist, releaseSettings } from './releaseSelect.js';
import { scheduleArtistRefresh, scheduleFollowUpSyncs } from './sync.js';
import type {
  AddAlbumInput,
  AddArtistResult,
  AddRequest,
  AddResponse,
  MetadataProfileSummary,
  PreflightConflict,
  PreflightResponse,
} from '../shared/types.js';

function groupByArtist(albums: AddAlbumInput[]): Map<string, AddAlbumInput[]> {
  const map = new Map<string, AddAlbumInput[]>();
  for (const a of albums) {
    const list = map.get(a.artistMbid);
    if (list) list.push(a);
    else map.set(a.artistMbid, [a]);
  }
  return map;
}

function profileAllowsAll(profile: MetadataProfileSummary, albums: AddAlbumInput[]): boolean {
  return albums.every((a) => missingTypesForProfile(profile, a.primaryType, a.secondaryTypes).length === 0);
}

/** Least permissive profile that still allows every given album (avoids flooding the artist with extra types). */
function findPermissiveProfile(profiles: MetadataProfileSummary[], albums: AddAlbumInput[]): MetadataProfileSummary | null {
  const candidates = profiles.filter((p) => profileAllowsAll(p, albums));
  candidates.sort((a, b) => a.primaryTypes.length + a.secondaryTypes.length - (b.primaryTypes.length + b.secondaryTypes.length));
  return candidates[0] ?? null;
}

export function validateAlbums(raw: unknown): AddAlbumInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, 'No albums selected.');
  if (raw.length > 500) throw new ApiError(400, 'Too many albums in one request (max 500).');
  return raw.map((item) => {
    const a = (item ?? {}) as Partial<AddAlbumInput>;
    if (typeof a.mbid !== 'string' || typeof a.artistMbid !== 'string' || !a.mbid || !a.artistMbid) {
      throw new ApiError(400, 'Each album needs a release-group MBID and an artist MBID.');
    }
    return {
      mbid: a.mbid,
      title: String(a.title ?? ''),
      artistMbid: a.artistMbid,
      artistName: String(a.artistName ?? ''),
      year: typeof a.year === 'number' ? a.year : null,
      primaryType: typeof a.primaryType === 'string' ? a.primaryType : null,
      secondaryTypes: Array.isArray(a.secondaryTypes) ? a.secondaryTypes.map(String) : [],
      releaseMbid: typeof a.releaseMbid === 'string' && MBID_RE.test(a.releaseMbid) ? a.releaseMbid : null,
    };
  });
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Metadata Profile Trap Guard: detect albums Lidarr would silently drop. */
export async function preflight(albums: AddAlbumInput[], metadataProfileId: number): Promise<PreflightResponse> {
  const [profiles, artists] = await Promise.all([getProfiles(), getArtists()]);
  const byMbid = new Map(artists.map((a) => [a.foreignArtistId, a]));
  const profileById = new Map(profiles.metadataProfiles.map((p) => [p.id, p]));
  const conflicts: PreflightConflict[] = [];
  for (const album of albums) {
    const existing = byMbid.get(album.artistMbid);
    const profile = profileById.get(existing ? existing.metadataProfileId : metadataProfileId);
    if (!profile) continue;
    const missing = missingTypesForProfile(profile, album.primaryType, album.secondaryTypes);
    if (missing.length) {
      conflicts.push({
        mbid: album.mbid,
        title: album.title,
        artistName: album.artistName,
        missingTypes: missing,
        existingArtist: Boolean(existing),
        profileName: profile.name,
      });
    }
  }
  const conflicted = albums.filter((a) => conflicts.some((c) => c.mbid === a.mbid));
  const suggested = conflicts.length ? findPermissiveProfile(profiles.metadataProfiles, conflicted) : null;
  return { conflicts, suggestedProfile: suggested ? { id: suggested.id, name: suggested.name } : null };
}

interface EditionStats {
  set: number;
  pending: boolean;
}

async function addNewArtist(
  artistMbid: string,
  albums: AddAlbumInput[],
  req: AddRequest,
  metadataProfileId: number,
  stats: EditionStats,
  warnings: string[],
): Promise<AddArtistResult> {
  const artistName = albums[0]?.artistName || artistMbid;
  const template = await lookupArtist(artistMbid);
  if (!template) throw new ApiError(404, `Lidarr could not find artist ${artistName} (${artistMbid}) in its metadata server.`);
  const editions = releaseSettings();
  // Spin Seek always runs the search itself once Lidarr has imported the artist (after picking editions):
  // Lidarr's own add-time search can silently leave the albums monitored but never searched.
  const body: Record<string, unknown> = {
    ...template,
    qualityProfileId: req.qualityProfileId,
    metadataProfileId,
    rootFolderPath: req.rootFolderPath,
    monitored: true,
    monitorNewItems: req.monitorEntireArtist ? 'all' : 'none',
    addOptions: {
      monitor: req.monitorEntireArtist ? 'all' : 'none',
      searchForMissingAlbums: false,
      albumsToMonitor: req.monitorEntireArtist ? [] : albums.map((a) => a.mbid),
    },
  };
  delete body.id;
  const created = await addArtist(body);
  const artistId = created?.id ?? (await getArtists()).find((a) => a.foreignArtistId === artistMbid)?.id;
  const displayName = template.artistName || artistName;
  if (artistId) {
    finalizeNewArtist(artistId, displayName, albums, {
      monitorAll: req.monitorEntireArtist,
      country: editions.country,
      auto: editions.auto,
    });
    stats.pending = true;
  } else {
    // Without an id there is nothing to follow up on: ask Lidarr to search everything it monitors.
    await runCommand('MissingAlbumSearch', {});
    warnings.push(`${displayName} was added, but Spin Seek couldn't find its id; started Lidarr's missing-album search instead.`);
  }
  return {
    artistName: template.artistName || artistName,
    artistMbid,
    action: 'added_artist',
    albumCount: albums.length,
    ok: true,
    error: null,
  };
}

async function updateExistingArtist(
  artist: LidarrArtist,
  albums: AddAlbumInput[],
  req: AddRequest,
  upgradeProfileTo: number | null,
  warnings: string[],
  matched: AddAlbumInput[],
  stats: EditionStats,
): Promise<AddArtistResult> {
  let current = artist;
  const needsUpdate = !artist.monitored || (upgradeProfileTo !== null && artist.metadataProfileId !== upgradeProfileTo) || req.monitorEntireArtist;
  if (needsUpdate) {
    current = await updateArtist({
      ...artist,
      monitored: true,
      ...(upgradeProfileTo !== null ? { metadataProfileId: upgradeProfileTo } : {}),
      ...(req.monitorEntireArtist ? { monitorNewItems: 'all' } : {}),
    });
  }

  const lidarrAlbums = await getAlbumsByArtist(current.id);
  const byForeignId = new Map(lidarrAlbums.map((a) => [a.foreignAlbumId, a]));
  const albumIds: number[] = [];
  const pairs: { album: AddAlbumInput; id: number }[] = [];
  for (const album of albums) {
    const existing = byForeignId.get(album.mbid);
    if (existing) {
      albumIds.push(existing.id);
      pairs.push({ album, id: existing.id });
      matched.push(album);
      continue;
    }
    // Album not in Lidarr's DB yet (e.g. filtered by metadata profile): look it up and add it.
    try {
      const lookup = await lookupAlbum(album.mbid);
      if (!lookup) {
        warnings.push(`Lidarr's metadata server doesn't know "${album.title}" yet; skipped.`);
        continue;
      }
      const added = await addAlbum({
        ...lookup,
        artistId: current.id,
        artist: lookup.artist ?? current,
        monitored: true,
        anyReleaseOk: true,
        addOptions: { searchForNewAlbum: false },
      });
      if (added?.id) {
        albumIds.push(added.id);
        pairs.push({ album, id: added.id });
        matched.push(album);
      }
    } catch (err) {
      warnings.push(`Could not add "${album.title}": ${errorMessage(err)}`);
    }
  }

  // Pick the standard (or explicitly chosen) edition before searching, so Lidarr expects the right tracklist.
  const editions = releaseSettings();
  for (const { album, id } of pairs) {
    if (!editions.auto && !album.releaseMbid) continue;
    try {
      if ((await applyPreferredRelease(id, { country: editions.country, releaseMbid: album.releaseMbid })) === 'changed') stats.set++;
    } catch (err) {
      warnings.push(`Could not set the edition for "${album.title}": ${errorMessage(err)}`);
    }
  }

  if (req.monitorEntireArtist) {
    await monitorAlbums(
      lidarrAlbums.map((a) => a.id),
      true,
    );
  }
  if (albumIds.length) {
    await monitorAlbums(albumIds, true);
    await runCommand('AlbumSearch', { albumIds });
  }
  if (req.monitorEntireArtist) await runCommand('ArtistSearch', { artistId: current.id });
  scheduleArtistRefresh(current.id, 15000);

  return {
    artistName: current.artistName,
    artistMbid: current.foreignArtistId,
    action: 'updated_artist',
    albumCount: albumIds.length,
    ok: albumIds.length > 0 || albums.length === 0,
    error: albumIds.length === 0 ? 'None of the selected albums could be matched in Lidarr.' : null,
  };
}

export async function addToLidarr(req: AddRequest): Promise<AddResponse> {
  if (!req.rootFolderPath) throw new ApiError(400, 'Choose a root folder.');
  if (!Number.isFinite(req.qualityProfileId) || req.qualityProfileId <= 0) throw new ApiError(400, 'Choose a quality profile.');
  if (!Number.isFinite(req.metadataProfileId) || req.metadataProfileId <= 0) throw new ApiError(400, 'Choose a metadata profile.');

  const [profiles, artists] = await Promise.all([getProfiles(), getArtists()]);
  const existingByMbid = new Map(artists.map((a) => [a.foreignArtistId, a]));
  const chosenProfile = profiles.metadataProfiles.find((p) => p.id === req.metadataProfileId);
  if (!chosenProfile) throw new ApiError(400, 'The selected metadata profile no longer exists in Lidarr.');

  const warnings: string[] = [];
  const results: AddArtistResult[] = [];
  const addedMbids: string[] = [];
  const editionStats: EditionStats = { set: 0, pending: false };
  let addedNewArtist = false;

  for (const [artistMbid, albums] of groupByArtist(req.albums)) {
    const existing = existingByMbid.get(artistMbid);
    const artistName = existing?.artistName ?? albums[0]?.artistName ?? artistMbid;
    try {
      const effectiveProfile = existing
        ? (profiles.metadataProfiles.find((p) => p.id === existing.metadataProfileId) ?? chosenProfile)
        : chosenProfile;
      let profileOverride: number | null = null;
      if (!profileAllowsAll(effectiveProfile, albums)) {
        const permissive = findPermissiveProfile(profiles.metadataProfiles, albums);
        if (req.usePermissiveProfile && permissive) {
          profileOverride = permissive.id;
          warnings.push(`${artistName}: using metadata profile "${permissive.name}" so EPs/Live/Compilations aren't ignored.`);
        } else {
          warnings.push(
            `${artistName}: metadata profile "${effectiveProfile.name}" doesn't allow some selected release types; Lidarr may ignore them.`,
          );
        }
      }

      const matched: AddAlbumInput[] = [];
      const result = existing
        ? await updateExistingArtist(existing, albums, req, profileOverride, warnings, matched, editionStats)
        : await addNewArtist(artistMbid, albums, req, profileOverride ?? req.metadataProfileId, editionStats, warnings);
      if (!existing) {
        addedNewArtist = true;
        matched.push(...albums);
      }
      results.push(result);
      if (matched.length) {
        addedMbids.push(...matched.map((a) => a.mbid));
        // New artists are searched later by the background follow-up, which records the search time.
        markAlbumsRequested(matched, Boolean(existing));
      }
    } catch (err) {
      results.push({
        artistName,
        artistMbid,
        action: existing ? 'updated_artist' : 'added_artist',
        albumCount: 0,
        ok: false,
        error: errorMessage(err),
      });
    }
  }

  if (addedNewArtist) scheduleFollowUpSyncs();
  return { results, warnings, addedMbids, editionsSet: editionStats.set, searchPending: editionStats.pending };
}
