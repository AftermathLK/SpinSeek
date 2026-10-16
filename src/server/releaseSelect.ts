// Sets which pressing ("release") Lidarr monitors for an album: the standard edition in the
// preferred country by default, or a specific edition the user picked in the Editions drawer.
import { chunk, db, getSetting } from './db.js';
import { pickPreferredRelease, type ReleaseCandidate } from './editions.js';
import { errorMessage, sleep } from './http.js';
import {
  getAlbum,
  getAlbumsByArtist,
  isArtistRefreshing,
  monitorAlbums,
  runCommand,
  updateAlbum,
  type LidarrAlbum,
  type LidarrRelease,
} from './lidarr.js';
import { scheduleArtistRefresh } from './sync.js';
import type { AddAlbumInput, PendingAdd, SelectReleaseResponse } from '../shared/types.js';

export function releaseSettings(): { auto: boolean; country: string } {
  return {
    auto: getSetting('auto_select_release') !== '0',
    country: getSetting('preferred_release_country') || 'US',
  };
}

function toCandidate(r: LidarrRelease): ReleaseCandidate {
  const formats = r.media?.length ? r.media.map((m) => m.mediumFormat ?? '') : r.format ? [r.format] : [];
  return {
    key: String(r.id),
    title: r.title ?? '',
    disambiguation: r.disambiguation ?? null,
    status: r.status ?? null,
    countries: r.country ?? [],
    formats,
    trackCount: r.trackCount ?? 0,
    mediumCount: r.mediumCount ?? r.media?.length ?? 1,
    date: null,
  };
}

export type ReleaseOutcome = 'changed' | 'unchanged' | 'no_releases';

/**
 * Monitors exactly one release of the album. Auto picks keep "any release OK" on so Lidarr can still
 * import a different pressing it happens to grab; an explicitly chosen edition is enforced.
 */
export async function applyPreferredRelease(
  albumId: number,
  opts: { country: string; releaseMbid?: string | null },
): Promise<ReleaseOutcome> {
  const album = await getAlbum(albumId);
  const releases = album.releases ?? [];
  if (releases.length === 0) return 'no_releases';
  const explicit = opts.releaseMbid ? releases.find((r) => r.foreignReleaseId === opts.releaseMbid) : undefined;
  let target = explicit;
  if (!target) {
    const pick = pickPreferredRelease(releases.map(toCandidate), opts.country);
    target = pick ? releases.find((r) => String(r.id) === pick.key) : undefined;
  }
  if (!target) return 'unchanged';
  const anyReleaseOk = !explicit;
  const monitored = releases.filter((r) => r.monitored);
  if (monitored.length === 1 && monitored[0].id === target.id && album.anyReleaseOk === anyReleaseOk) return 'unchanged';
  const chosen = target;
  await updateAlbum({
    ...album,
    anyReleaseOk,
    releases: releases.map((r) => ({ ...r, monitored: r.id === chosen.id })),
  });
  return 'changed';
}

const POLL_MS = 5000;
const NEW_ARTIST_TIMEOUT_MS = 5 * 60 * 1000;
/** Polls with an unchanged album list and no running refresh before giving up on albums that never appear. */
const SETTLED_POLLS = 3;
const KEEP_FINISHED_MS = 10 * 60 * 1000;

const jobs = new Map<number, PendingAdd>();

/** Follow-ups for recently added artists (shown in the Live Activity popover). */
export function listPendingAdds(): PendingAdd[] {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function markSearched(mbids: string[]): void {
  const now = Date.now();
  for (const part of chunk(mbids, 500)) {
    if (part.length === 0) continue;
    db.prepare(`UPDATE library_albums SET last_searched_at = ? WHERE album_mbid IN (${part.map(() => '?').join(',')})`).run(
      now,
      ...part,
    );
  }
}

/**
 * New artists: Lidarr imports albums asynchronously after the artist is added, and its own
 * "search on add" isn't reliable. Wait until the selected albums exist and the artist refresh has
 * finished, set editions, then monitor + search explicitly. Runs in the background so
 * "Send to Lidarr" returns immediately.
 */
export function finalizeNewArtist(
  artistId: number,
  artistName: string,
  albums: AddAlbumInput[],
  opts: { monitorAll: boolean; country: string; auto: boolean },
): void {
  const job: PendingAdd = {
    artistId,
    artistName,
    albumCount: albums.length,
    state: 'waiting',
    message: 'Waiting for Lidarr to finish importing…',
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(artistId, job);

  const run = async () => {
    const wanted = new Map(albums.map((a) => [a.mbid, a]));
    const deadline = Date.now() + NEW_ARTIST_TIMEOUT_MS;
    let found = new Map<string, LidarrAlbum>();
    let lastCount = -1;
    let settled = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        const list = await getAlbumsByArtist(artistId);
        found = new Map(list.filter((a) => wanted.has(a.foreignAlbumId)).map((a) => [a.foreignAlbumId, a]));
        const stable = list.length > 0 && list.length === lastCount;
        lastCount = list.length;
        settled = stable && !(await isArtistRefreshing(artistId)) ? settled + 1 : 0;
        // Everything is there, or Lidarr is done and the rest will never show up (e.g. filtered by profile).
        if ((found.size === wanted.size && settled >= 1) || settled >= SETTLED_POLLS) break;
      } catch (err) {
        console.warn(`[add] waiting for ${artistName}: ${errorMessage(err)}`);
      }
    }

    let changed = 0;
    for (const [mbid, album] of found) {
      const input = wanted.get(mbid);
      if (!opts.auto && !input?.releaseMbid) continue;
      try {
        if ((await applyPreferredRelease(album.id, { country: opts.country, releaseMbid: input?.releaseMbid })) === 'changed') changed++;
      } catch (err) {
        console.warn(`[editions] ${album.title}: ${errorMessage(err)}`);
      }
    }
    const ids = [...found.values()].map((a) => a.id);
    if (ids.length) await monitorAlbums(ids, true);
    // Missing albums or "monitor entire artist": one artist-wide search covers every monitored album.
    const artistWide = opts.monitorAll || found.size < wanted.size;
    if (artistWide) await runCommand('ArtistSearch', { artistId });
    else if (ids.length) await runCommand('AlbumSearch', { albumIds: ids });
    markSearched([...found.keys()]);

    job.state = 'done';
    job.finishedAt = Date.now();
    job.message = [
      artistWide ? 'Artist-wide search started' : `Search started for ${ids.length} album${ids.length === 1 ? '' : 's'}`,
      found.size < wanted.size ? `${found.size}/${wanted.size} albums found in Lidarr` : null,
      changed ? `${changed} standard edition${changed === 1 ? '' : 's'} set` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`[add] ${artistName}: ${job.message}`);
    scheduleArtistRefresh(artistId, 10000);
  };
  run().catch((err) => {
    job.state = 'failed';
    job.finishedAt = Date.now();
    job.message = `Search not started: ${errorMessage(err)}`;
    console.warn(`[add] ${artistName} follow-up failed: ${errorMessage(err)}`);
  });
}

/** Library bulk action: switch albums already in Lidarr to their standard edition. */
export async function selectStandardEditions(albumMbids: string[]): Promise<SelectReleaseResponse> {
  const { country } = releaseSettings();
  const result: SelectReleaseResponse = { changed: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const rows: { album_mbid: string; lidarr_album_id: number | null; title: string }[] = [];
  for (const part of chunk([...new Set(albumMbids)], 500)) {
    rows.push(
      ...(db
        .prepare(
          `SELECT album_mbid, lidarr_album_id, title FROM library_albums WHERE album_mbid IN (${part.map(() => '?').join(',')})`,
        )
        .all(...part) as typeof rows),
    );
  }
  result.skipped += albumMbids.length - rows.length;
  for (const row of rows) {
    if (!row.lidarr_album_id) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = await applyPreferredRelease(row.lidarr_album_id, { country });
      if (outcome === 'changed') result.changed++;
      else if (outcome === 'unchanged') result.unchanged++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      if (result.errors.length < 5) result.errors.push(`${row.title}: ${errorMessage(err)}`);
    }
  }
  return result;
}
