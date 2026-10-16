import { Compass, Plug, Radio, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArtistPage } from './discover/ArtistPage';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { api, errorText, isAbort, streamNdjson } from '../lib/api';
import { storageGetEnum, storageGetFlags, storageGetNumber, storageSet } from '../lib/format';
import { FilterBar } from './discover/FilterBar';
import { DEFAULT_FILTERS, FILTER_LABELS, fromResolved, isVisible, newGroup, type FilterKey, type Filters, type GroupState } from './discover/model';
import { Omnibar, type AiOptions, type OmnibarMode } from './discover/Omnibar';
import { ResultGroupCard } from './discover/ResultGroupCard';
import { SendBar } from './discover/SendBar';
import { MAX_BATCH_ITEMS, parseBatchQuery } from '../../shared/parse';
import { editionLabel } from '../components/EditionsDrawer';
import type {
  AiEvent,
  AlbumResult,
  ArtistProfile,
  BatchEvent,
  Edition,
  LastfmPeriod,
  RecsEvent,
  RecsMode,
  ResultGroup,
  SimilarArtist,
} from '../../shared/types';

interface ArtistPageState {
  mbid: string;
  profile: ArtistProfile | null;
  profileError: string | null;
  group: GroupState | null;
  groupError: string | null;
  /** undefined = Last.fm off / not configured; null = loading. */
  similar: SimilarArtist[] | null | undefined;
}

interface Props {
  active: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
}

function filterKeyOf(album: AlbumResult): FilterKey {
  if (album.isEdition) return 'deluxe';
  return album.category === 'studio' ? 'studio' : album.category;
}

export function DiscoverTab({ active, inputRef }: Props) {
  const { settings, openSettings, artist, openArtist, closeArtist } = useApp();
  const toast = useToast();
  const [artistPage, setArtistPage] = useState<ArtistPageState | null>(null);
  const savedScroll = useRef(0);
  const [mode, setMode] = useState<OmnibarMode>(() => storageGetEnum<OmnibarMode>('omnibarMode', ['standard', 'ai', 'recs'], 'standard'));
  const [recsMode, setRecsMode] = useState<RecsMode>(() => storageGetEnum<RecsMode>('recsMode', ['foryou', 'similar', 'scrobbles'], 'foryou'));
  const [recsPeriod, setRecsPeriod] = useState<LastfmPeriod>(() =>
    storageGetEnum<LastfmPeriod>('recsPeriod', ['7day', '1month', '6month', 'overall'], '1month'),
  );
  const [similarArtist, setSimilarArtist] = useState('');
  const [seeds, setSeeds] = useState<string[]>([]);
  const usedSeeds = useRef(new Set<string>());
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aiOptions, setAiOptions] = useState<AiOptions>(() => {
    const flags = storageGetFlags('aiOptions', { includeOwned: false, newArtistsOnly: false });
    const count = storageGetNumber('aiCount', 12, 3, 30);
    return { ...flags, count: [6, 12, 20, 30].includes(count) ? count : 12 };
  });
  const [filters, setFilters] = useState<Filters>(() => storageGetFlags('filters', DEFAULT_FILTERS));
  const [groups, setGroups] = useState<GroupState[]>([]);
  const [selected, setSelected] = useState<Map<string, AlbumResult>>(new Map());
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const changeMode = (m: OmnibarMode) => {
    setMode(m);
    storageSet('omnibarMode', m);
  };

  // A tab turned off in Settings → Features falls back to Standard search.
  const features = settings?.features;
  useEffect(() => {
    if (!features) return;
    if ((mode === 'ai' && !features.ai) || (mode === 'recs' && !features.recs)) setMode('standard');
  }, [mode, features]);

  const changeRecsMode = useCallback((m: RecsMode) => {
    setRecsMode(m);
    storageSet('recsMode', m);
  }, []);
  const changeRecsPeriod = (p: LastfmPeriod) => {
    setRecsPeriod(p);
    storageSet('recsPeriod', p);
  };

  const changeAiOptions = (o: AiOptions) => {
    setAiOptions(o);
    storageSet('aiOptions', { includeOwned: o.includeOwned, newArtistsOnly: o.newArtistsOnly });
    storageSet('aiCount', o.count);
  };

  const toggleFilter = useCallback((key: FilterKey) => {
    setFilters((f) => {
      const next = { ...f, [key]: !f[key] };
      storageSet('filters', next);
      return next;
    });
  }, []);

  const patchGroup = useCallback((id: string, patch: (g: GroupState) => GroupState) => {
    setGroups((list) => list.map((g) => (g.id === id ? patch(g) : g)));
  }, []);

  const autoSelect = useCallback((albums: AlbumResult[]) => {
    const picks = albums.filter((a) => a.autoCheck);
    if (picks.length === 0) return;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const a of picks) next.set(a.mbid, a);
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setGroups((list) => list.map((g) => (g.loading ? { ...g, loading: false, statusMessage: g.statusMessage ? 'Stopped.' : null } : g)));
  }, []);

  /** Standard / batch search. `text` searches just that item (query pills, quick results). */
  const runBatch = async (text: string = query) => {
    const parsed = parseBatchQuery(text);
    if (parsed.length === 0) return;
    if (parsed.length > MAX_BATCH_ITEMS) {
      toast.warning(`Batch searches are limited to ${MAX_BATCH_ITEMS} items`, `You entered ${parsed.length}. Split the list into smaller batches.`);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      await streamNdjson<BatchEvent>(
        '/api/search/batch',
        { query: text },
        (event) => {
          if (event.type === 'start') {
            const placeholders = event.groups.map((g) => newGroup({ id: g.id, query: g.query, kind: g.kind, loading: true }));
            setGroups((list) => [...placeholders, ...list]);
          } else if (event.type === 'group') {
            patchGroup(event.group.id, (prev) => fromResolved(event.group, prev));
            autoSelect(event.group.albums);
          } else if (event.type === 'error') {
            toast.error('Search failed', event.error);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!isAbort(err)) toast.error('Search failed', errorText(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
        setGroups((list) => list.map((g) => (g.loading && (g.kind === 'artist' || g.kind === 'album') ? { ...g, loading: false } : g)));
      }
    }
  };

  /** 📻 Recommendations (Last.fm), streamed into a group like AI picks. */
  const runRecs = async ({ shuffle = false }: { shuffle?: boolean }) => {
    if (recsMode === 'similar' && !similarArtist.trim()) return;
    if (artist) closeArtist();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = `recs-${Date.now().toString(36)}`;
    const title =
      recsMode === 'similar' ? `Similar to ${similarArtist.trim()}` : recsMode === 'scrobbles' ? 'Your Last.fm top albums' : 'For You';
    const description =
      recsMode === 'similar'
        ? 'Top studio albums from similar artists (Last.fm)'
        : recsMode === 'scrobbles'
          ? `${settings?.lastfmUsername ?? ''} · ${recsPeriod === '7day' ? 'last 7 days' : recsPeriod === '1month' ? 'last month' : recsPeriod === '6month' ? 'last 6 months' : 'all time'}`
          : 'Based on your ratings and Lidarr library';
    setGroups((list) => [
      newGroup({ id, query: description, title, kind: 'recs', loading: true, statusMessage: 'Starting…' }),
      ...list,
    ]);
    setRunning(true);
    try {
      await streamNdjson<RecsEvent>(
        '/api/recs/stream',
        {
          mode: recsMode,
          artist: similarArtist.trim(),
          period: recsPeriod,
          excludeSeeds: shuffle ? [...usedSeeds.current] : [],
          shuffle,
        },
        (event) => {
          switch (event.type) {
            case 'status':
              patchGroup(id, (g) => ({ ...g, statusMessage: event.message }));
              break;
            case 'seeds':
              setSeeds(event.seeds);
              for (const s of event.seeds) usedSeeds.current.add(s);
              patchGroup(id, (g) => ({ ...g, query: `Because you like ${event.seeds.join(', ')}` }));
              break;
            case 'album':
              patchGroup(id, (g) =>
                g.albums.some((a) => a.mbid === event.album.mbid) ? g : { ...g, albums: [...g.albums, event.album] },
              );
              break;
            case 'error':
              patchGroup(id, (g) => ({ ...g, loading: false, error: event.error, statusMessage: null }));
              toast.error('Recommendations failed', event.error);
              break;
            case 'done':
              patchGroup(id, (g) => ({
                ...g,
                loading: false,
                statusMessage: null,
                notices: event.count === 0 && !g.error ? ['No albums could be verified on MusicBrainz this time. Try Shuffle Seeds.'] : g.notices,
              }));
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!isAbort(err)) {
        patchGroup(id, (g) => ({ ...g, loading: false, error: errorText(err), statusMessage: null }));
        toast.error('Recommendations failed', errorText(err));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
      patchGroup(id, (g) => (g.loading ? { ...g, loading: false, statusMessage: null } : g));
    }
  };

  /** Quick results / query pills: name → MusicBrainz artist → artist page. */
  const openArtistByName = async (name: string) => {
    try {
      const found = await api.get<{ mbid: string; name: string }>(`/api/search/resolve-artist?name=${encodeURIComponent(name)}`);
      openArtistPage(found.mbid, found.name);
    } catch (err) {
      toast.error(`Couldn't open ${name}`, errorText(err));
    }
  };

  const runAi = async () => {
    const text = prompt.trim();
    if (!text) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = `ai-${Date.now().toString(36)}`;
    setGroups((list) => [newGroup({ id, query: text, kind: 'ai', loading: true, statusMessage: 'Asking the AI…' }), ...list]);
    setRunning(true);
    let resolved = 0;
    let total = 0;
    const progress = () => `Verifying picks on MusicBrainz… ${resolved}/${total}`;
    try {
      await streamNdjson<AiEvent>(
        '/api/ai/discover',
        { prompt: text, ...aiOptions },
        (event) => {
          switch (event.type) {
            case 'status':
              patchGroup(id, (g) => ({ ...g, statusMessage: event.message }));
              break;
            case 'picks':
              total = event.picks.length;
              patchGroup(id, (g) => ({ ...g, expected: total, statusMessage: progress() }));
              break;
            case 'album':
              resolved++;
              patchGroup(id, (g) =>
                g.albums.some((a) => a.mbid === event.album.mbid)
                  ? { ...g, statusMessage: progress() }
                  : { ...g, albums: [...g.albums, event.album], statusMessage: progress() },
              );
              break;
            case 'unresolved':
              resolved++;
              patchGroup(id, (g) => ({ ...g, unresolved: [...g.unresolved, { pick: event.pick, error: event.error }], statusMessage: progress() }));
              break;
            case 'error':
              patchGroup(id, (g) => ({ ...g, loading: false, error: event.error, statusMessage: null }));
              toast.error('AI Discovery failed', event.error);
              break;
            case 'done':
              patchGroup(id, (g) => ({
                ...g,
                loading: false,
                statusMessage: null,
                notices: g.albums.length === 0 && !g.error ? ['No verifiable recommendations this time — try rephrasing.'] : g.notices,
              }));
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!isAbort(err)) {
        patchGroup(id, (g) => ({ ...g, loading: false, error: errorText(err), statusMessage: null }));
        toast.error('AI Discovery failed', errorText(err));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
      patchGroup(id, (g) => (g.loading ? { ...g, loading: false, statusMessage: null } : g));
    }
  };

  const submit = () => {
    if (artist) closeArtist();
    if (mode === 'standard') void runBatch();
    else void runAi();
  };

  // Artist page: load profile + discography whenever a different artist is opened.
  const artistMbid = artist?.mbid ?? null;
  useEffect(() => {
    if (!artist) {
      setArtistPage(null);
      const y = savedScroll.current;
      requestAnimationFrame(() => window.scrollTo(0, y));
      return;
    }
    let cancelled = false;
    const mbid = artist.mbid;
    const similarEnabled = Boolean(settings?.features.recs && settings.lastfmConfigured);
    setArtistPage({ mbid, profile: null, profileError: null, group: null, groupError: null, similar: similarEnabled ? null : undefined });
    window.scrollTo(0, 0);
    const update = (patch: Partial<ArtistPageState>) => {
      if (!cancelled) setArtistPage((s) => (s && s.mbid === mbid ? { ...s, ...patch } : s));
    };
    if (similarEnabled) {
      api
        .get<{ artists: SimilarArtist[] }>(`/api/artist/${mbid}/similar`)
        .then((res) => update({ similar: res.artists }))
        .catch(() => update({ similar: [] }));
    }
    api
      .get<ArtistProfile>(`/api/artist/${mbid}/profile`)
      .then((profile) => update({ profile }))
      .catch((err) => update({ profileError: errorText(err) }));
    api
      .post<ResultGroup>('/api/search/artist', { mbid, groupId: `artist-${mbid}`, query: artist.name })
      .then((group) => update({ group: fromResolved(group) }))
      .catch((err) => update({ groupError: errorText(err) }));
    return () => {
      cancelled = true;
    };
    // Re-run only when a different artist is opened or the page closes.
  }, [artistMbid]);

  const openArtistPage = useCallback(
    (mbid: string, name: string) => {
      if (!artist) savedScroll.current = window.scrollY;
      openArtist(mbid, name);
    },
    [artist, openArtist],
  );
  const onOpenArtist = useCallback((album: AlbumResult) => openArtistPage(album.artistMbid, album.artistName), [openArtistPage]);
  const onOpenSimilar = useCallback(
    (a: SimilarArtist) => {
      if (a.mbid) openArtistPage(a.mbid, a.name);
      else void openArtistByName(a.name);
    },
    // openArtistByName only uses stable setters/callbacks.
    [openArtistPage],
  );

  const onToggle = useCallback((album: AlbumResult) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(album.mbid)) next.delete(album.mbid);
      else next.set(album.mbid, album);
      return next;
    });
  }, []);

  const onSelectMany = useCallback((albums: AlbumResult[], select: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const a of albums) {
        if (select) next.set(a.mbid, a);
        else next.delete(a.mbid);
      }
      return next;
    });
  }, []);

  /** Apply an album update to every search group and the open artist page. */
  const mapAllAlbums = useCallback((fn: (a: AlbumResult) => AlbumResult) => {
    const mapGroup = (g: GroupState): GroupState => {
      let changed = false;
      const albums = g.albums.map((a) => {
        const next = fn(a);
        if (next !== a) changed = true;
        return next;
      });
      return changed ? { ...g, albums } : g;
    };
    setGroups((list) => list.map(mapGroup));
    setArtistPage((s) => (s?.group ? { ...s, group: mapGroup(s.group) } : s));
  }, []);

  const patchAlbumEverywhere = useCallback(
    (mbid: string, patch: Partial<AlbumResult>) => mapAllAlbums((a) => (a.mbid === mbid ? { ...a, ...patch } : a)),
    [mapAllAlbums],
  );

  const onRate = useCallback(
    (album: AlbumResult, rating: number | null) => {
      const previous = album.userRating;
      patchAlbumEverywhere(album.mbid, { userRating: rating });
      api
        .put(`/api/ratings/${album.mbid}`, {
          rating,
          artistName: album.artistName,
          albumTitle: album.title,
          year: album.year,
          communityRating: album.communityRating,
        })
        .catch((err) => {
          patchAlbumEverywhere(album.mbid, { userRating: previous });
          toast.error('Could not save rating', errorText(err));
        });
    },
    [patchAlbumEverywhere, toast],
  );

  /** Pin a specific pressing from the Editions drawer (null = back to the automatic standard pick). */
  const onChooseEdition = useCallback(
    (album: AlbumResult, edition: Edition | null) => {
      const patch: Partial<AlbumResult> = edition
        ? { releaseMbid: edition.mbid, releaseLabel: editionLabel(edition) }
        : { releaseMbid: undefined, releaseLabel: undefined };
      patchAlbumEverywhere(album.mbid, patch);
      setSelected((prev) => {
        const next = new Map(prev);
        // Choosing an edition implies wanting the album.
        if (edition || next.has(album.mbid)) next.set(album.mbid, { ...album, ...patch });
        return next;
      });
      if (edition) toast.info(`Edition set: ${editionLabel(edition)}`, 'Album selected. Lidarr will monitor exactly this pressing.');
    },
    [patchAlbumEverywhere, toast],
  );

  const onSwitchArtist = useCallback(
    async (groupId: string, artistMbid: string) => {
      const current = groupsRef.current.find((g) => g.id === groupId);
      patchGroup(groupId, (g) => ({ ...g, loading: true, albums: [], error: null, collapsed: false }));
      try {
        const group = await api.post<ResultGroup>('/api/search/artist', { mbid: artistMbid, groupId, query: current?.query });
        // Keep the original alternatives list so the user can switch back.
        const alternatives = current
          ? [...(current.artist && current.artist.mbid !== artistMbid ? [current.artist] : []), ...current.alternatives].filter(
              (a) => a.mbid !== artistMbid,
            )
          : group.alternatives;
        patchGroup(groupId, (prev) => fromResolved({ ...group, alternatives }, prev));
      } catch (err) {
        patchGroup(groupId, (g) => ({ ...g, loading: false, error: errorText(err) }));
        toast.error('Could not load artist', errorText(err));
      }
    },
    [patchGroup, toast],
  );

  const onCollapse = useCallback((groupId: string) => patchGroup(groupId, (g) => ({ ...g, collapsed: !g.collapsed })), [patchGroup]);
  const onRemove = useCallback((groupId: string) => setGroups((list) => list.filter((g) => g.id !== groupId)), []);

  const allAlbums = useMemo(() => groups.flatMap((g) => g.albums), [groups]);
  const visibleAlbums = useMemo(
    () => groups.flatMap((g) => (g.collapsed ? [] : g.albums.filter((a) => isVisible(a, filters) && !a.alreadyOwned))),
    [groups, filters],
  );
  const counts = useMemo(() => {
    const c = Object.fromEntries(FILTER_LABELS.map((f) => [f.key, 0])) as Record<FilterKey, number>;
    for (const a of allAlbums) c[filterKeyOf(a)]++;
    return c;
  }, [allAlbums]);

  const selectStudio = () => onSelectMany(visibleAlbums.filter((a) => a.category === 'studio' && !a.isEdition), true);
  const selectMissing = () => onSelectMany(visibleAlbums.filter((a) => a.lidarrStatus !== 'downloaded'), true);
  const clearResults = () => {
    stop();
    setGroups([]);
    setSelected(new Map());
  };

  const onSent = useCallback(
    (addedMbids: string[]) => {
      const now = Date.now();
      const added = new Set(addedMbids);
      mapAllAlbums((a) =>
        added.has(a.mbid)
          ? {
              ...a,
              lidarrStatus: a.lidarrStatus === 'downloaded' || a.lidarrStatus === 'partial' ? a.lidarrStatus : 'missing_monitored',
              lastSearchedAt: now,
            }
          : a,
      );
      setSelected((prev) => {
        const next = new Map(prev);
        for (const m of addedMbids) next.delete(m);
        return next;
      });
    },
    [mapAllAlbums],
  );

  const selectedList = useMemo(() => [...selected.values()], [selected]);

  return (
    <div className="space-y-4">
      {settings && !settings.lidarrConfigured && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm">
          <Plug className="h-4 w-4 text-violet-300" />
          <span className="text-violet-100">Connect Lidarr to see library status and send albums.</span>
          <button className="btn-primary ml-auto px-3 py-1 text-xs" onClick={() => openSettings('lidarr')}>
            Open Settings
          </button>
        </div>
      )}

      <Omnibar
        inputRef={inputRef}
        mode={mode}
        onModeChange={changeMode}
        query={query}
        onQueryChange={setQuery}
        prompt={prompt}
        onPromptChange={setPrompt}
        aiOptions={aiOptions}
        onAiOptionsChange={changeAiOptions}
        running={running}
        onSubmit={submit}
        onStop={stop}
        onSearchText={(text) => {
          if (artist) closeArtist();
          void runBatch(text);
        }}
        onOpenArtistByName={(name) => void openArtistByName(name)}
        recs={{
          recsMode,
          onRecsModeChange: changeRecsMode,
          similarArtist,
          onSimilarArtistChange: setSimilarArtist,
          period: recsPeriod,
          onPeriodChange: changeRecsPeriod,
          seeds,
          onRun: (opts) => void runRecs(opts),
        }}
      />

      {artist ? (
        <ArtistPage
          artist={artist}
          profile={artistPage?.profile ?? null}
          profileError={artistPage?.profileError ?? null}
          group={artistPage?.group ?? null}
          groupError={artistPage?.groupError ?? null}
          selected={selected}
          onToggle={onToggle}
          onSelectMany={onSelectMany}
          onRate={onRate}
          onChooseEdition={onChooseEdition}
          onBack={closeArtist}
          similar={artistPage?.similar}
          onOpenSimilar={onOpenSimilar}
        />
      ) : groups.length > 0 ? (
        <>
          <FilterBar
            filters={filters}
            onToggle={toggleFilter}
            counts={counts}
            onSelectStudio={selectStudio}
            onSelectMissing={selectMissing}
            onDeselectAll={() => setSelected(new Map())}
            onClearResults={clearResults}
            selectedCount={selected.size}
            visibleCount={visibleAlbums.length}
            totalCount={allAlbums.length}
          />
          <div className="space-y-3">
            {groups.map((group) => (
              <ResultGroupCard
                key={group.id}
                group={group}
                filters={filters}
                selected={selected}
                onToggle={onToggle}
                onRate={onRate}
                onChooseEdition={onChooseEdition}
                onOpenArtist={onOpenArtist}
                onOpenArtistPage={openArtistPage}
                onSelectMany={onSelectMany}
                onSwitchArtist={onSwitchArtist}
                onCollapse={onCollapse}
                onRemove={onRemove}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            {mode === 'ai' ? (
              <Sparkles className="h-6 w-6 text-fuchsia-400" />
            ) : mode === 'recs' ? (
              <Radio className="h-6 w-6 text-sky-400" />
            ) : (
              <Compass className="h-6 w-6 text-violet-400" />
            )}
          </div>
          <div>
            <p className="font-medium text-zinc-200">
              {mode === 'ai' ? 'Let AI dig through the crates' : mode === 'recs' ? 'Albums you will probably love' : 'Find albums to add to Lidarr'}
            </p>
            <p className="mt-1 max-w-md text-sm text-zinc-500">
              {mode === 'ai'
                ? 'Recommendations use your 4★+ ratings for taste and skip what you already own. Every pick is verified on MusicBrainz.'
                : mode === 'recs'
                  ? 'Similar-artist data from Last.fm, top studio albums verified on MusicBrainz. Albums you already have are hidden.'
                  : 'Search an artist for their discography, “Artist - Album” to auto-check one release, or paste a whole list to batch-resolve.'}
            </p>
          </div>
        </div>
      )}

      {active && (
        <SendBar selected={selectedList} onClear={() => setSelected(new Map())} onSent={onSent} />
      )}
    </div>
  );
}
