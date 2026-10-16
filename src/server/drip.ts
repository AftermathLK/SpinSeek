import { COOLDOWN_MS } from './config.js';
import { chunk, db, getNumberSetting, getSetting, setSetting } from './db.js';
import { errorMessage } from './http.js';
import { lidarrConfigured, runCommand } from './lidarr.js';
import { listPendingAdds } from './releaseSelect.js';
import type { DripQueueItem, DripStatus, EnqueueResponse } from '../shared/types.js';

const MAX_ATTEMPTS = 3;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let lastRunAt: number | null = null;

export function dripBatchSize(): number {
  return Math.min(10, Math.max(1, Math.round(getNumberSetting('drip_batch_size', 2))));
}

export function dripIntervalSec(): number {
  return Math.min(3600, Math.max(15, Math.round(getNumberSetting('drip_interval_sec', 45))));
}

function isPaused(): boolean {
  return getSetting('drip_paused') === '1';
}

interface QueueRow {
  id: number;
  lidarr_album_id: number;
  album_mbid: string;
  artist_name: string;
  album_title: string;
  status: string;
  queued_at: number;
  processed_at: number | null;
  attempts: number | null;
  error: string | null;
}

function mapRow(r: QueueRow): DripQueueItem {
  return {
    id: r.id,
    albumMbid: r.album_mbid,
    artistName: r.artist_name,
    albumTitle: r.album_title,
    status: r.status,
    queuedAt: r.queued_at,
    processedAt: r.processed_at,
    error: r.error,
  };
}

function pendingCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM drip_queue WHERE status IN ('pending', 'processing')").get() as { n: number }).n;
}

/** One worker tick: pop `drip_batch_size` albums and fire a single AlbumSearch command. */
async function tick(): Promise<void> {
  if (ticking || isPaused() || !lidarrConfigured()) return;
  const batch = db
    .prepare("SELECT * FROM drip_queue WHERE status = 'pending' ORDER BY id LIMIT ?")
    .all(dripBatchSize()) as QueueRow[];
  if (batch.length === 0) return;

  ticking = true;
  lastRunAt = Date.now();
  const ids = batch.map((b) => b.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE drip_queue SET status = 'processing' WHERE id IN (${placeholders})`).run(...ids);
  try {
    await runCommand('AlbumSearch', { albumIds: batch.map((b) => b.lidarr_album_id) });
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE drip_queue SET status = 'done', processed_at = ?, error = NULL WHERE id IN (${placeholders})`).run(now, ...ids);
      const touch = db.prepare('UPDATE library_albums SET last_searched_at = ? WHERE album_mbid = ?');
      for (const b of batch) touch.run(now, b.album_mbid);
    })();
    console.log(`[drip] searched ${batch.length}: ${batch.map((b) => `${b.artist_name} – ${b.album_title}`).join(', ')}`);
  } catch (err) {
    const message = errorMessage(err);
    console.warn(`[drip] AlbumSearch failed: ${message}`);
    const now = Date.now();
    db.prepare(
      `UPDATE drip_queue SET
         attempts = COALESCE(attempts, 0) + 1,
         error = ?,
         status = CASE WHEN COALESCE(attempts, 0) + 1 >= ? THEN 'failed' ELSE 'pending' END,
         processed_at = CASE WHEN COALESCE(attempts, 0) + 1 >= ? THEN ? ELSE processed_at END
       WHERE id IN (${placeholders})`,
    ).run(message, MAX_ATTEMPTS, MAX_ATTEMPTS, now, ...ids);
  } finally {
    ticking = false;
  }
}

function safeTick(): void {
  tick().catch((err) => console.warn(`[drip] tick error: ${errorMessage(err)}`));
}

export function startDripWorker(): void {
  // Recover rows stuck mid-flight from a previous crash/restart.
  db.prepare("UPDATE drip_queue SET status = 'pending' WHERE status = 'processing'").run();
  // Housekeeping: drop finished rows older than a week.
  db.prepare("DELETE FROM drip_queue WHERE status IN ('done', 'failed') AND processed_at < ?").run(Date.now() - 7 * 86400000);
  restartDripWorker();
}

export function restartDripWorker(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(safeTick, dripIntervalSec() * 1000);
}

/** Kick the worker right away if the last batch was long enough ago (keeps the spacing guarantee). */
function kickIfIdle(): void {
  const intervalMs = dripIntervalSec() * 1000;
  if (!lastRunAt || Date.now() - lastRunAt >= intervalMs) {
    restartDripWorker();
    safeTick();
  }
}

interface EnqueueCandidate {
  album_mbid: string;
  lidarr_album_id: number | null;
  artist_name: string;
  title: string;
  last_searched_at: number | null;
}

function insertCandidates(candidates: EnqueueCandidate[], ignoreCooldown: boolean): EnqueueResponse {
  const result: EnqueueResponse = { queued: 0, skippedCooldown: 0, skippedDuplicate: 0, skippedNotInLidarr: 0 };
  const now = Date.now();
  const wasEmpty = pendingCount() === 0;
  const already = new Set(
    (db.prepare("SELECT album_mbid FROM drip_queue WHERE status IN ('pending', 'processing')").all() as { album_mbid: string }[]).map(
      (r) => r.album_mbid,
    ),
  );
  const insert = db.prepare(
    `INSERT INTO drip_queue (lidarr_album_id, album_mbid, artist_name, album_title, status, queued_at, processed_at, attempts)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL, 0)`,
  );
  db.transaction(() => {
    for (const c of candidates) {
      if (!c.lidarr_album_id) {
        result.skippedNotInLidarr++;
        continue;
      }
      if (already.has(c.album_mbid)) {
        result.skippedDuplicate++;
        continue;
      }
      if (!ignoreCooldown && c.last_searched_at && now - c.last_searched_at < COOLDOWN_MS) {
        result.skippedCooldown++;
        continue;
      }
      insert.run(c.lidarr_album_id, c.album_mbid, c.artist_name, c.title, now);
      already.add(c.album_mbid);
      result.queued++;
    }
  })();
  if (result.queued > 0) {
    if (wasEmpty) setSetting('drip_run_started_at', String(now));
    kickIfIdle();
  }
  return result;
}

export function enqueueAlbums(albumMbids: string[], ignoreCooldown: boolean): EnqueueResponse {
  const candidates: EnqueueCandidate[] = [];
  for (const part of chunk([...new Set(albumMbids)], 500)) {
    candidates.push(
      ...(db
        .prepare(
          `SELECT album_mbid, lidarr_album_id, artist_name, title, last_searched_at FROM library_albums
           WHERE album_mbid IN (${part.map(() => '?').join(',')})`,
        )
        .all(...part) as EnqueueCandidate[]),
    );
  }
  const found = new Set(candidates.map((c) => c.album_mbid));
  const result = insertCandidates(candidates, ignoreCooldown);
  result.skippedNotInLidarr += albumMbids.filter((m) => !found.has(m)).length;
  return result;
}

/** "Queue All Missing (Unsearched in 24h)". */
export function enqueueAllMissing(includeCutoff: boolean): EnqueueResponse {
  const where = includeCutoff
    ? "(status = 'missing_monitored' OR (status = 'partial' AND monitored = 1) OR cutoff_unmet = 1)"
    : "(status = 'missing_monitored' OR (status = 'partial' AND monitored = 1))";
  const candidates = db
    .prepare(
      `SELECT album_mbid, lidarr_album_id, artist_name, title, last_searched_at FROM library_albums
       WHERE ${where} AND lidarr_album_id IS NOT NULL ORDER BY artist_name COLLATE NOCASE, year`,
    )
    .all() as EnqueueCandidate[];
  return insertCandidates(candidates, false);
}

export function setDripPaused(paused: boolean): void {
  setSetting('drip_paused', paused ? '1' : '0');
  if (!paused) kickIfIdle();
}

export function clearDripQueue(): number {
  return db.prepare("DELETE FROM drip_queue WHERE status = 'pending'").run().changes;
}

export function getDripStatus(): DripStatus {
  const runStart = Number(getSetting('drip_run_started_at')) || 0;
  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(status = 'pending'), 0) AS pending,
         COALESCE(SUM(status = 'processing'), 0) AS processing,
         COALESCE(SUM(status = 'done' AND processed_at >= ?), 0) AS done,
         COALESCE(SUM(status = 'failed' AND processed_at >= ?), 0) AS failed
       FROM drip_queue`,
    )
    .get(runStart, runStart) as { pending: number; processing: number; done: number; failed: number };
  const upcoming = (
    db.prepare("SELECT * FROM drip_queue WHERE status IN ('processing', 'pending') ORDER BY status DESC, id LIMIT 8").all() as QueueRow[]
  ).map(mapRow);
  const recent = (
    db.prepare("SELECT * FROM drip_queue WHERE status IN ('done', 'failed') ORDER BY processed_at DESC LIMIT 8").all() as QueueRow[]
  ).map(mapRow);
  const intervalSec = dripIntervalSec();
  const active = counts.pending + counts.processing > 0;
  return {
    paused: isPaused(),
    pending: counts.pending,
    processing: counts.processing,
    done: counts.done,
    failed: counts.failed,
    total: counts.pending + counts.processing + counts.done + counts.failed,
    batchSize: dripBatchSize(),
    intervalSec,
    nextRunAt: active && !isPaused() ? (lastRunAt ?? Date.now()) + intervalSec * 1000 : null,
    lastRunAt,
    upcoming,
    recent,
    pendingAdds: listPendingAdds(),
  };
}
