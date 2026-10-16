import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { DeezerInfo } from '../../shared/types';

/**
 * Batches per-row Deezer lookups (popularity badge) into a single request every ~80ms,
 * so a 60-row discography costs one HTTP round-trip instead of 60.
 */
const cache = new Map<string, DeezerInfo | null>();
const waiters = new Map<string, ((info: DeezerInfo | null) => void)[]>();
let queue: { key: string; artist: string; album: string }[] = [];
let timer: number | null = null;

function keyFor(artist: string, album: string): string {
  return `${artist.toLowerCase()}|${album.toLowerCase()}`;
}

async function flush(): Promise<void> {
  timer = null;
  const batch = queue.splice(0, 50);
  if (queue.length) timer = window.setTimeout(flush, 80);
  if (batch.length === 0) return;
  let results: Record<string, DeezerInfo | null> = {};
  try {
    results = (await api.post<{ results: Record<string, DeezerInfo | null> }>('/api/deezer/info', { items: batch })).results ?? {};
  } catch {
    results = {};
  }
  for (const item of batch) {
    const info = results[item.key] ?? null;
    cache.set(item.key, info);
    for (const resolve of waiters.get(item.key) ?? []) resolve(info);
    waiters.delete(item.key);
  }
}

export function loadDeezerInfo(artist: string, album: string): Promise<DeezerInfo | null> {
  const key = keyFor(artist, album);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  return new Promise((resolve) => {
    const list = waiters.get(key);
    if (list) {
      list.push(resolve);
      return;
    }
    waiters.set(key, [resolve]);
    queue.push({ key, artist, album });
    if (timer === null) timer = window.setTimeout(flush, 80);
  });
}

/** Loads Deezer info once the element scrolls into view. */
export function useDeezerInfo(artist: string, album: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<DeezerInfo | null>(() => cache.get(keyFor(artist, album)) ?? null);

  useEffect(() => {
    const el = ref.current;
    if (!el || cache.has(keyFor(artist, album))) {
      setInfo(cache.get(keyFor(artist, album)) ?? null);
      return;
    }
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          loadDeezerInfo(artist, album).then((result) => {
            if (!cancelled) setInfo(result);
          });
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [artist, album]);

  return { ref, info };
}
