import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works from both src/server (tsx) and dist/server (compiled). */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

function resolveConfigDir(): string {
  const fromEnv = process.env.CONFIG_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    if (fs.existsSync('/config')) {
      fs.accessSync('/config', fs.constants.W_OK);
      return '/config';
    }
  } catch {
    // /config exists but is not writable: fall back to ./data
  }
  return path.join(PROJECT_ROOT, 'data');
}

export const CONFIG_DIR = resolveConfigDir();
fs.mkdirSync(CONFIG_DIR, { recursive: true });

export const DB_PATH = path.join(CONFIG_DIR, 'spinseek.db');
export const PORT = Number(process.env.PORT) || 3080;
export const HOST = process.env.HOST?.trim() || '0.0.0.0';
export const CLIENT_DIST = path.join(PROJECT_ROOT, 'dist', 'client');

export const ENV_AUTH_USERNAME = process.env.AUTH_USERNAME?.trim() ?? '';
export const ENV_AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? '';
export const ENV_AUTH_ENABLED = Boolean(ENV_AUTH_USERNAME && ENV_AUTH_PASSWORD);

export const APP_VERSION = '2.0.0';
/** MusicBrainz asks clients to identify themselves with a contact URL. */
export const USER_AGENT = 'SpinSeek/2.0.0 ( https://github.com/AftermathLK/SpinSeek )';

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
