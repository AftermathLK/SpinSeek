import type { AlbumCategory } from '../../shared/types';

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function hoursAgo(ts: number): number {
  return Math.max(0, Math.floor((Date.now() - ts) / 3600000));
}

export function searchedAgoLabel(ts: number): string {
  const h = hoursAgo(ts);
  return `Searched ${h < 1 ? '<1h' : `${h}h`} ago`;
}

export function withinCooldown(ts: number | null | undefined): boolean {
  return Boolean(ts && Date.now() - ts < 24 * 3600 * 1000);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function typeLabel(category: AlbumCategory, primaryType: string | null, secondaryTypes: string[]): string {
  switch (category) {
    case 'studio':
      return 'Album';
    case 'ep':
      return 'EP';
    case 'live':
      return 'Live';
    case 'compilation':
      return 'Compilation';
    case 'single':
      return secondaryTypes.some((s) => /remix|dj-mix/i.test(s)) ? 'Remix' : 'Single';
    default:
      return secondaryTypes[0] || primaryType || 'Other';
  }
}

export function libraryTypeLabel(primaryType: string | null, secondaryTypes: string[]): string {
  if (secondaryTypes.length) return secondaryTypes[0];
  return primaryType || 'Album';
}

export function coverArtArchiveUrl(mbid: string): string {
  return `https://coverartarchive.org/release-group/${mbid}/front-250`;
}

export function deezerArtworkUrl(artist: string, album: string): string {
  return `/api/deezer/artwork?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`;
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`spinseek:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Stored value only if it is one of `allowed` (guards against stale/corrupt localStorage). */
export function storageGetEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = storageGet<unknown>(key, fallback);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function storageGetNumber(key: string, fallback: number, min: number, max: number): number {
  const value = storageGet<unknown>(key, fallback);
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Merge stored booleans over defaults, ignoring unknown keys and non-boolean values. */
export function storageGetFlags<T extends Record<string, boolean>>(key: string, defaults: T): T {
  const stored = storageGet<unknown>(key, {});
  const out = { ...defaults };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      const v = (stored as Record<string, unknown>)[k as string];
      if (typeof v === 'boolean') out[k] = v as T[keyof T];
    }
  }
  return out;
}

export function storageSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(`spinseek:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode / blocked)
  }
}
