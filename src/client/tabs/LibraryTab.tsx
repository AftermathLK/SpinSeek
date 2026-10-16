import { Disc3, Grid3X3, Library, ListPlus, Loader2, Plug, Radar, RefreshCw, Search, Users, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { api, errorText } from '../lib/api';
import { storageGetEnum, storageSet, timeAgo } from '../lib/format';
import { ArtistGroupCard } from './library/ArtistGroupCard';
import { LibraryAlbumCard, isSearchable } from './library/LibraryAlbumCard';
import type {
  DripStatus,
  EnqueueResponse,
  LibraryAlbum,
  LibraryAlbumsResponse,
  LibraryArtist,
  LibraryFilter,
  LibraryStats,
  SelectReleaseResponse,
  SyncResult,
} from '../../shared/types';

interface Props {
  active: boolean;
  inputRef: RefObject<HTMLInputElement>;
}

type ViewMode = 'artists' | 'grid';
type SortMode = 'artist' | 'newest' | 'oldest' | 'title' | 'searched';

const FILTERS: { id: LibraryFilter; label: string; stat: keyof LibraryStats }[] = [
  { id: 'all', label: 'All', stat: 'total' },
  { id: 'downloaded', label: 'Downloaded', stat: 'downloaded' },
  { id: 'missing', label: 'Missing (Monitored)', stat: 'missing' },
  { id: 'cutoff', label: 'Cutoff Unmet', stat: 'cutoff' },
  { id: 'unmonitored', label: 'Unmonitored', stat: 'unmonitored' },
  { id: 'favorites', label: 'My 4★+ Favorites', stat: 'favorites' },
];

const PAGE_SIZE = 120;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function enqueueSummary(res: EnqueueResponse): string {
  const parts: string[] = [];
  if (res.skippedCooldown) parts.push(`${res.skippedCooldown} searched <24h ago`);
  if (res.skippedDuplicate) parts.push(`${res.skippedDuplicate} already queued`);
  if (res.skippedNotInLidarr) parts.push(`${res.skippedNotInLidarr} not synced yet`);
  return parts.length ? `Skipped: ${parts.join(' · ')}` : '';
}

export function LibraryTab({ active, inputRef }: Props) {
  const { settings, openSettings, libraryVersion, bumpActivity, bumpLibrary, setBottomInset, openArtist } = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q.trim(), 200);
  const [filter, setFilter] = useState<LibraryFilter>(() =>
    storageGetEnum<LibraryFilter>('libraryFilter', FILTERS.map((f) => f.id), 'all'),
  );
  const [view, setView] = useState<ViewMode>(() => storageGetEnum<ViewMode>('libraryView', ['artists', 'grid'], 'artists'));
  const [sort, setSort] = useState<SortMode>(() =>
    storageGetEnum<SortMode>('librarySort', ['artist', 'newest', 'oldest', 'title', 'searched'], 'artist'),
  );
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [albums, setAlbums] = useState<LibraryAlbum[]>([]);
  const [total, setTotal] = useState(0);
  const [artists, setArtists] = useState<LibraryArtist[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<Map<string, LibraryAlbum>>(new Map());
  const [ignoreCooldown, setIgnoreCooldown] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [patches, setPatches] = useState<Map<string, Partial<LibraryAlbum>>>(new Map());
  const barRef = useRef<HTMLDivElement>(null);

  const lidarrConfigured = settings?.lidarrConfigured ?? false;

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.get<LibraryStats>('/api/library/stats'));
    } catch {
      // non-fatal
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'grid') {
        const params = new URLSearchParams({ q: debouncedQ, filter, sort, limit: String(PAGE_SIZE), offset: '0' });
        const res = await api.get<LibraryAlbumsResponse>(`/api/library/albums?${params}`);
        setAlbums(res.items);
        setTotal(res.total);
      } else {
        const params = new URLSearchParams({ q: debouncedQ, filter });
        const res = await api.get<{ items: LibraryArtist[] }>(`/api/library/artists?${params}`);
        setArtists(res.items);
      }
      setPatches(new Map());
    } catch (err) {
      toast.error('Could not load library', errorText(err));
    } finally {
      setLoading(false);
    }
  }, [view, debouncedQ, filter, sort, toast]);

  // Load whenever the tab becomes visible or its inputs change; skip work while hidden.
  useEffect(() => {
    if (!active) return;
    void load();
    void loadStats();
  }, [active, load, loadStats, libraryVersion]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ q: debouncedQ, filter, sort, limit: String(PAGE_SIZE), offset: String(albums.length) });
      const res = await api.get<LibraryAlbumsResponse>(`/api/library/albums?${params}`);
      setAlbums((list) => [...list, ...res.items]);
      setTotal(res.total);
    } catch (err) {
      toast.error('Could not load more', errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const changeFilter = (f: LibraryFilter) => {
    setFilter(f);
    storageSet('libraryFilter', f);
  };
  const changeView = (v: ViewMode) => {
    setView(v);
    storageSet('libraryView', v);
  };
  const changeSort = (s: SortMode) => {
    setSort(s);
    storageSet('librarySort', s);
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await api.post<{ result: SyncResult; stats: LibraryStats }>('/api/library/sync');
      setStats(res.stats);
      toast.success('Synced with Lidarr', `${res.result.artists} artists · ${res.result.albums} albums · ${res.result.cutoffUnmet} cutoff unmet`);
      bumpLibrary();
    } catch (err) {
      toast.error('Sync failed', errorText(err));
    } finally {
      setSyncing(false);
    }
  };

  const onToggle = useCallback((album: LibraryAlbum) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(album.albumMbid)) next.delete(album.albumMbid);
      else next.set(album.albumMbid, album);
      return next;
    });
  }, []);

  const onSelectMany = useCallback((list: LibraryAlbum[], select: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const a of list) {
        if (select) next.set(a.albumMbid, a);
        else next.delete(a.albumMbid);
      }
      return next;
    });
  }, []);

  const patchAlbum = useCallback((mbid: string, patch: Partial<LibraryAlbum>) => {
    setAlbums((list) => list.map((a) => (a.albumMbid === mbid ? { ...a, ...patch } : a)));
    setPatches((prev) => new Map(prev).set(mbid, { ...prev.get(mbid), ...patch }));
  }, []);

  const onRate = useCallback(
    (album: LibraryAlbum, rating: number | null) => {
      const previous = album.userRating;
      patchAlbum(album.albumMbid, { userRating: rating });
      api
        .put(`/api/ratings/${album.albumMbid}`, {
          rating,
          artistName: album.artistName,
          albumTitle: album.title,
          year: album.year,
          communityRating: null,
        })
        .then(() => {
          if (filter === 'favorites' || (previous ?? 0) >= 4 !== (rating ?? 0) >= 4) void loadStats();
        })
        .catch((err) => {
          patchAlbum(album.albumMbid, { userRating: previous });
          toast.error('Could not save rating', errorText(err));
        });
    },
    [patchAlbum, toast, filter, loadStats],
  );

  const afterEnqueue = (res: EnqueueResponse & { status: DripStatus }) => {
    const detail = enqueueSummary(res);
    if (res.queued > 0) {
      const minutes = Math.ceil((res.queued / Math.max(1, res.status.batchSize)) * res.status.intervalSec / 60);
      toast.success(
        `Queued ${res.queued} album${res.queued === 1 ? '' : 's'} for drip search`,
        [`~${minutes} min at ${res.status.batchSize} every ${res.status.intervalSec}s`, detail].filter(Boolean).join('\n'),
      );
    } else {
      toast.info('Nothing new to queue', detail || undefined);
    }
    bumpActivity();
    void load();
    void loadStats();
  };

  const forceSearch = async () => {
    setQueueBusy(true);
    try {
      const res = await api.post<EnqueueResponse & { status: DripStatus }>('/api/drip/enqueue', {
        albumMbids: [...selected.keys()],
        ignoreCooldown,
      });
      afterEnqueue(res);
      setSelected(new Map());
    } catch (err) {
      toast.error('Could not queue searches', errorText(err));
    } finally {
      setQueueBusy(false);
    }
  };

  const applyStandardEditions = async () => {
    setQueueBusy(true);
    try {
      const res = await api.post<SelectReleaseResponse>('/api/lidarr/select-release', { albumMbids: [...selected.keys()] });
      const detail = [
        res.unchanged ? `${res.unchanged} already on the standard edition` : '',
        res.skipped ? `${res.skipped} skipped (not synced yet)` : '',
        res.failed ? `${res.failed} failed` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      toast.success(`Standard edition set for ${res.changed} album${res.changed === 1 ? '' : 's'}`, detail || undefined);
      if (res.errors.length) toast.warning('Some albums could not be updated', res.errors.join('\n'));
    } catch (err) {
      toast.error('Could not set editions', errorText(err));
    } finally {
      setQueueBusy(false);
    }
  };

  const queueAllMissing = async () => {
    setQueueBusy(true);
    try {
      afterEnqueue(await api.post<EnqueueResponse & { status: DripStatus }>('/api/drip/enqueue-all-missing', { includeCutoff: false }));
    } catch (err) {
      toast.error('Could not queue searches', errorText(err));
    } finally {
      setQueueBusy(false);
    }
  };

  const showBar = active && selected.size > 0;
  useLayoutEffect(() => {
    if (!showBar) return;
    const el = barRef.current;
    if (!el) return;
    const update = () => setBottomInset(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      setBottomInset(0);
    };
  }, [showBar, setBottomInset]);

  const selectableOnPage = useMemo(() => albums.filter(isSearchable), [albums]);
  const cooldownSelected = useMemo(
    () => [...selected.values()].filter((a) => a.lastSearchedAt && Date.now() - a.lastSearchedAt < 24 * 3600 * 1000).length,
    [selected],
  );

  if (settings && !lidarrConfigured) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <Library className="h-6 w-6 text-violet-400" />
        </div>
        <div>
          <p className="font-medium text-zinc-200">Connect Lidarr to browse your library</p>
          <p className="mt-1 text-sm text-zinc-500">Spin Seek mirrors your artists and albums locally for instant search and safe bulk searching.</p>
        </div>
        <button className="btn-primary" onClick={() => openSettings('lidarr')}>
          <Plug className="h-4 w-4" /> Connect Lidarr
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            ref={inputRef}
            className="input pl-9 pr-9"
            placeholder="Filter by artist, album or year…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          />
          {q && (
            <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200" onClick={() => setQ('')}>
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={sync} disabled={syncing || stats?.syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing || stats?.syncing ? 'animate-spin' : ''}`} />
            Sync with Lidarr
          </button>
          <button className="btn-secondary" onClick={queueAllMissing} disabled={queueBusy || !stats?.missing}>
            <ListPlus className="h-4 w-4" /> Queue All Missing <span className="hidden xl:inline">(Unsearched in 24h)</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => changeFilter(f.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.id
                  ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              }`}
            >
              {f.label}
              {stats && <span className="ml-1.5 text-[10px] text-zinc-500">{(stats[f.stat] as number) ?? 0}</span>}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {view === 'grid' && (
            <select className="select w-auto py-1 text-xs" value={sort} onChange={(e) => changeSort(e.target.value as SortMode)}>
              <option value="artist">Artist A–Z</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A–Z</option>
              <option value="searched">Least recently searched</option>
            </select>
          )}
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
            <button
              onClick={() => changeView('artists')}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${view === 'artists' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
            >
              <Users className="h-3.5 w-3.5" /> Group by Artist
            </button>
            <button
              onClick={() => changeView('grid')}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${view === 'grid' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
            >
              <Grid3X3 className="h-3.5 w-3.5" /> Album Grid
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        <span>
          Last sync {timeAgo(stats?.lastSyncAt)}
          {stats ? ` · ${stats.artists} artists · ${stats.total} albums` : ''}
        </span>
        {stats?.lastSyncError && <span className="text-red-300">Last sync failed: {stats.lastSyncError}</span>}
        {view === 'grid' && selectableOnPage.length > 0 && (
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => onSelectMany(selectableOnPage, true)}>
            Select {selectableOnPage.length} missing / cutoff shown
          </button>
        )}
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      {stats && stats.total === 0 && !loading && (
        <div className="card p-8 text-center text-sm text-zinc-400">
          Your library hasn't been synced yet.{' '}
          <button className="text-violet-300 hover:underline" onClick={sync}>
            Sync with Lidarr now
          </button>
          .
        </div>
      )}

      {view === 'grid' ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {albums.map((album) => (
              <LibraryAlbumCard
                key={album.albumMbid}
                album={album}
                checked={selected.has(album.albumMbid)}
                onToggle={onToggle}
                onRate={onRate}
              />
            ))}
          </div>
          {albums.length < total && (
            <div className="flex justify-center">
              <button className="btn-secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load more ({total - albums.length} remaining)
              </button>
            </div>
          )}
          {!loading && albums.length === 0 && stats && stats.total > 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">No albums match this filter.</p>
          )}
        </>
      ) : (
        <div className="space-y-2">
          {artists.map((artist) => (
            <ArtistGroupCard
              key={artist.artistMbid}
              artist={artist}
              filter={filter}
              q={debouncedQ}
              version={libraryVersion}
              selected={selected}
              onToggle={onToggle}
              onSelectMany={onSelectMany}
              onRate={onRate}
              onOpenArtist={openArtist}
              patches={patches}
            />
          ))}
          {!loading && artists.length === 0 && stats && stats.total > 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">No artists match this filter.</p>
          )}
        </div>
      )}

      {showBar && (
        <div
          ref={barRef}
          className="fixed inset-x-0 bottom-0 z-30 animate-slide-up border-t border-violet-500/30 bg-zinc-950/95 shadow-[0_-12px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
            <button className="btn-ghost p-1.5" onClick={() => setSelected(new Map())} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
            <div>
              <p className="text-sm font-semibold">{selected.size} selected</p>
              {cooldownSelected > 0 && (
                <p className="text-[11px] text-amber-300/80">
                  {cooldownSelected} searched in the last 24h{ignoreCooldown ? '' : ' — will be skipped'}
                </p>
              )}
            </div>
            <button
              className="btn-secondary ml-auto"
              onClick={applyStandardEditions}
              disabled={queueBusy}
              title="Make Lidarr monitor the standard pressing (preferred country, usual track count, no deluxe/exclusive)"
            >
              <Disc3 className="h-4 w-4" /> Use Standard Edition
            </button>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" className="checkbox" checked={ignoreCooldown} onChange={(e) => setIgnoreCooldown(e.target.checked)} />
              Ignore 24h Cooldown
            </label>
            <button className="btn-primary px-4 py-2" onClick={forceSearch} disabled={queueBusy}>
              {queueBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
              Force Search via Drip Queue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
