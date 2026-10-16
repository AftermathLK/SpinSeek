import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS library_artists (
  artist_mbid TEXT PRIMARY KEY,
  lidarr_id INTEGER,
  name TEXT,
  monitored INTEGER,
  album_count INTEGER,
  track_file_count INTEGER,
  size_on_disk INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS library_albums (
  album_mbid TEXT PRIMARY KEY,
  lidarr_album_id INTEGER,
  artist_mbid TEXT,
  artist_name TEXT,
  title TEXT,
  year INTEGER,
  primary_type TEXT,
  secondary_types TEXT,
  monitored INTEGER,
  status TEXT,
  percent_of_tracks REAL,
  cutoff_unmet INTEGER,
  cover_url TEXT,
  last_searched_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_library_albums_artist ON library_albums(artist_mbid);
CREATE INDEX IF NOT EXISTS idx_library_albums_status ON library_albums(status);
CREATE INDEX IF NOT EXISTS idx_library_albums_lidarr ON library_albums(lidarr_album_id);

CREATE TABLE IF NOT EXISTS ratings (
  album_mbid TEXT PRIMARY KEY,
  artist_name TEXT,
  album_title TEXT,
  year INTEGER,
  user_rating INTEGER,
  community_rating REAL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

CREATE TABLE IF NOT EXISTS drip_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lidarr_album_id INTEGER,
  album_mbid TEXT,
  artist_name TEXT,
  album_title TEXT,
  status TEXT,
  queued_at INTEGER,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drip_queue_status ON drip_queue(status, id);
CREATE INDEX IF NOT EXISTS idx_drip_queue_album ON drip_queue(album_mbid);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
// Retry bookkeeping for the drip worker.
ensureColumn('drip_queue', 'attempts', 'INTEGER DEFAULT 0');
ensureColumn('drip_queue', 'error', 'TEXT');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTING_DEFAULTS: Record<string, string> = {
  lidarr_url: '',
  lidarr_api_key: '',
  root_folder_path: '',
  quality_profile_id: '',
  metadata_profile_id: '',
  ai_provider: 'openai',
  ai_base_url: 'https://api.openai.com/v1',
  ai_api_key: '',
  ai_model: '',
  drip_batch_size: '2',
  drip_interval_sec: '45',
  drip_paused: '0',
  auto_select_release: '1',
  preferred_release_country: 'US',
  lastfm_api_key: '',
  lastfm_username: '',
  feature_ai: '1',
  feature_recs: '1',
  feature_autocomplete: '1',
  feature_previews: '1',
  drip_run_started_at: '0',
  webhook_secret: '',
  api_key: '',
  session_secret: '',
  auth_username: '',
  auth_password_hash: '',
  last_sync_at: '0',
  last_sync_error: '',
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getSetting(key: string): string {
  const row = getSettingStmt.get(key) as { value: string | null } | undefined;
  return row?.value ?? SETTING_DEFAULTS[key] ?? '';
}

export function setSetting(key: string, value: string): void {
  setSettingStmt.run(key, value);
}

export function getNumberSetting(key: string, fallback: number): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && getSetting(key) !== '' ? n : fallback;
}

export function getOptionalIntSetting(key: string): number | null {
  const raw = getSetting(key);
  if (raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function randomToken(bytes = 20): string {
  return crypto.randomBytes(bytes).toString('hex');
}

// Secrets (API keys, webhook/session secrets) are generated and encrypted by secrets.ts.

// ---------------------------------------------------------------------------
// search_cache (MusicBrainz / Deezer lookups)
// ---------------------------------------------------------------------------

const cacheGetStmt = db.prepare('SELECT payload_json, expires_at FROM search_cache WHERE cache_key = ?');
const cacheSetStmt = db.prepare(
  `INSERT INTO search_cache (cache_key, payload_json, expires_at) VALUES (?, ?, ?)
   ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at`,
);
const cachePurgeStmt = db.prepare('DELETE FROM search_cache WHERE expires_at < ?');

export function cacheGet<T>(key: string): T | undefined {
  const row = cacheGetStmt.get(key) as { payload_json: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    return undefined;
  }
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  cacheSetStmt.run(key, JSON.stringify(value), Date.now() + ttlMs);
}

export function purgeExpiredCache(): number {
  return cachePurgeStmt.run(Date.now()).changes;
}

/** Chunk helper for IN (...) queries. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
