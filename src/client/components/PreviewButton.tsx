import { Loader2, Pause, Play } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { usePlayer } from '../context/PlayerContext';

interface Props {
  previewKey: string;
  artist: string;
  album: string;
  compact?: boolean;
}

export function PreviewButton({ previewKey, artist, album, compact }: Props) {
  const { current, status, loadingKey, play } = usePlayer();
  const { settings } = useApp();
  // Settings → Features: "Enable 30s audio previews".
  if (settings && !settings.features.previews) return null;
  const isCurrent = current?.key === previewKey;
  const isLoading = loadingKey === previewKey;
  const isPlaying = isCurrent && status === 'playing';
  const Icon = isLoading ? Loader2 : isPlaying ? Pause : Play;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        play(previewKey, artist, album);
      }}
      title={isPlaying ? 'Pause preview' : 'Play 30s preview (Deezer)'}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        isCurrent
          ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
          : 'border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-violet-500/50 hover:text-violet-200'
      }`}
    >
      <Icon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''} ${!isPlaying && !isLoading ? 'fill-current' : ''}`} />
      {!compact && (isPlaying ? 'Playing' : '30s Preview')}
    </button>
  );
}
