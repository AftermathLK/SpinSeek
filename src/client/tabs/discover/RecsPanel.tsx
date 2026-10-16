import { Disc3, Headphones, Link2, Radio, Settings2, Shuffle, Sparkles, Square, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import type { LastfmPeriod, LibraryArtist, RecsMode } from '../../../shared/types';

export interface RecsPanelProps {
  recsMode: RecsMode;
  onRecsModeChange: (mode: RecsMode) => void;
  similarArtist: string;
  onSimilarArtistChange: (value: string) => void;
  period: LastfmPeriod;
  onPeriodChange: (period: LastfmPeriod) => void;
  seeds: string[];
  running: boolean;
  onRun: (opts: { shuffle?: boolean }) => void;
  onStop: () => void;
}

const PERIODS: { id: LastfmPeriod; label: string }[] = [
  { id: '7day', label: 'Last 7 days' },
  { id: '1month', label: 'Last month' },
  { id: '6month', label: 'Last 6 months' },
  { id: 'overall', label: 'All time' },
];

/** 📻 Recommendations controls (Last.fm + MusicBrainz, no LLM). */
export function RecsPanel(props: RecsPanelProps) {
  const { recsMode, onRecsModeChange, similarArtist, onSimilarArtistChange, period, onPeriodChange, seeds, running, onRun, onStop } = props;
  const { settings, openSettings } = useApp();
  const [libraryArtists, setLibraryArtists] = useState<string[]>([]);
  const ready = settings?.lastfmConfigured ?? false;
  const hasUser = Boolean(settings?.lastfmUsername);

  useEffect(() => {
    if (recsMode !== 'similar' || libraryArtists.length > 0) return;
    api
      .get<{ items: LibraryArtist[] }>('/api/library/artists?filter=all')
      .then((res) => setLibraryArtists(res.items.map((a) => a.name)))
      .catch(() => setLibraryArtists([]));
  }, [recsMode, libraryArtists.length]);

  useEffect(() => {
    if (recsMode === 'scrobbles' && !hasUser) onRecsModeChange('foryou');
  }, [recsMode, hasUser, onRecsModeChange]);

  const modes: { id: RecsMode; label: string; icon: typeof Target }[] = [
    { id: 'foryou', label: 'For You', icon: Target },
    { id: 'similar', label: 'Similar to Artist', icon: Link2 },
    ...(hasUser ? [{ id: 'scrobbles' as const, label: 'My Last.fm Scrobbles', icon: Headphones }] : []),
  ];

  if (!ready) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-3 text-sm text-sky-100">
        <Radio className="h-4 w-4 shrink-0 text-sky-300" />
        Recommendations use Last.fm's similar-artist data. Add a free Last.fm API key to turn them on.
        <button className="btn-secondary ml-auto px-2 py-1 text-xs" onClick={() => openSettings('lastfm')}>
          <Settings2 className="h-3.5 w-3.5" /> Configure Last.fm
        </button>
      </div>
    );
  }

  const runButton = (label: string, disabled = false) =>
    running ? (
      <button className="btn-secondary" onClick={onStop}>
        <Square className="h-4 w-4 fill-current" /> Stop
      </button>
    ) : (
      <button className="btn-primary" onClick={() => onRun({})} disabled={disabled}>
        <Sparkles className="h-4 w-4" /> {label}
      </button>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {modes.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onRecsModeChange(id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              recsMode === id
                ? 'border-sky-500/60 bg-sky-500/15 text-sky-100'
                : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
            }`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {recsMode === 'foryou' && (
        <div className="space-y-2.5">
          <p className="text-xs text-zinc-400">
            Up to 5 seed artists from your 4★+ ratings and most-collected Lidarr artists → similar artists on Last.fm → their
            top studio albums.
          </p>
          {seeds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-zinc-500">Seeds:</span>
              {seeds.map((s) => (
                <span key={s} className="pill border-zinc-700 bg-zinc-800/70 text-zinc-300">
                  {s}
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {runButton('Get recommendations')}
            {!running && (
              <button className="btn-secondary" onClick={() => onRun({ shuffle: true })}>
                <Shuffle className="h-4 w-4" /> Shuffle Seeds
              </button>
            )}
          </div>
        </div>
      )}

      {recsMode === 'similar' && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running && similarArtist.trim()) onRun({});
          }}
        >
          <input
            className="input min-w-[14rem] flex-1"
            list="spinseek-library-artists"
            placeholder="Any artist, e.g. Kendrick Lamar or Good Charlotte"
            value={similarArtist}
            onChange={(e) => onSimilarArtistChange(e.target.value)}
          />
          <datalist id="spinseek-library-artists">
            {libraryArtists.slice(0, 500).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {running ? (
            <button type="button" className="btn-secondary" onClick={onStop}>
              <Square className="h-4 w-4 fill-current" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!similarArtist.trim()}>
              <Link2 className="h-4 w-4" /> Find similar
            </button>
          )}
        </form>
      )}

      {recsMode === 'scrobbles' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">
            Top albums of <span className="text-zinc-200">{settings?.lastfmUsername}</span>
          </span>
          <select className="select w-auto py-1.5 text-sm" value={period} onChange={(e) => onPeriodChange(e.target.value as LastfmPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {runButton('Load top albums')}
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Disc3 className="h-3 w-3" /> Shows what you play but don't have; downloaded albums are hidden
          </span>
        </div>
      )}
    </div>
  );
}
