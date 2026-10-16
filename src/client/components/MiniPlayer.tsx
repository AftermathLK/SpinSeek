import { Loader2, Pause, Play, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { usePlayer, usePlayerProgress } from '../context/PlayerContext';
import { formatClock } from '../lib/format';

/** Global mini audio player (bottom-right), lifted above any sticky action bar. */
export function MiniPlayer() {
  const { current, status, toggle, stop } = usePlayer();
  const { volume, setVolume, currentTime, duration, seek } = usePlayerProgress();
  const { bottomInset } = useApp();
  if (!current && status !== 'loading') return null;

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className="fixed right-4 z-40 w-[min(22rem,calc(100vw-2rem))] animate-slide-up rounded-2xl border border-zinc-800 bg-zinc-900/95 p-3 shadow-2xl shadow-black/50 backdrop-blur transition-[bottom] duration-200"
      style={{ bottom: bottomInset + 16 }}
    >
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-800">
          {current?.coverUrl && <img src={current.coverUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-100">{current?.trackTitle ?? 'Loading preview…'}</p>
          <p className="truncate text-xs text-zinc-400">
            {current ? `${current.artistName} · ${current.albumTitle}` : 'Fetching from Deezer'}
          </p>
        </div>
        <button
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-60"
          onClick={toggle}
          disabled={!current}
          aria-label={status === 'playing' ? 'Pause' : 'Play'}
        >
          {status === 'loading' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : status === 'playing' ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="ml-0.5 h-4 w-4 fill-current" />
          )}
        </button>
        <button className="btn-ghost p-1.5" onClick={stop} aria-label="Close player">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="w-8 text-right font-mono text-[10px] text-zinc-500">{formatClock(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 30}
          step={0.1}
          value={currentTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-violet-500"
          aria-label="Seek"
          style={{ background: `linear-gradient(to right, #8b5cf6 ${pct}%, #3f3f46 ${pct}%)` }}
        />
        <span className="w-8 font-mono text-[10px] text-zinc-500">{formatClock(duration)}</span>
        <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setVolume(volume === 0 ? 0.8 : 0)} aria-label="Mute">
          <VolumeIcon className="h-4 w-4" />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="h-1 w-16 cursor-pointer accent-violet-500"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
