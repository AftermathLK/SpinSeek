import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { storageGetNumber, storageSet } from '../lib/format';
import { useToast } from './ToastContext';
import type { PreviewTrack } from '../../shared/types';

export interface NowPlaying extends PreviewTrack {
  key: string;
}

type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused';

interface PlayerApi {
  current: NowPlaying | null;
  status: PlayerStatus;
  loadingKey: string | null;
  play: (key: string, artist: string, album: string) => void;
  toggle: () => void;
  stop: () => void;
}

/** Fast-changing playback state lives in its own context so album rows don't re-render on every timeupdate. */
interface PlayerProgressApi {
  volume: number;
  currentTime: number;
  duration: number;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);
const PlayerProgressContext = createContext<PlayerProgressApi | null>(null);

/** Single shared <audio> element: only one 30s preview ever plays at a time. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef(0);
  const currentRef = useRef<NowPlaying | null>(null);
  const [current, setCurrentState] = useState<NowPlaying | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [volume, setVolumeState] = useState<number>(() => storageGetNumber('volume', 0.8, 0, 1));
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(30);

  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
    audioRef.current.volume = volume;
  }

  const setCurrent = useCallback((value: NowPlaying | null) => {
    currentRef.current = value;
    setCurrentState(value);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 30);
    const onPlay = () => setStatus('playing');
    const onPause = () => setStatus((s) => (s === 'loading' ? s : 'paused'));
    const onEnded = () => {
      setStatus('paused');
      setCurrentTime(0);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const play = useCallback(
    (key: string, artist: string, album: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (currentRef.current?.key === key) {
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
        return;
      }
      const requestId = ++requestRef.current;
      audio.pause();
      setLoadingKey(key);
      setStatus('loading');
      api
        .get<PreviewTrack>(`/api/deezer/preview?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`)
        .then(async (track) => {
          if (requestId !== requestRef.current) return;
          setCurrent({ ...track, key });
          setCurrentTime(0);
          setDuration(30);
          audio.src = track.previewUrl;
          try {
            await audio.play();
          } catch (err) {
            setStatus('paused');
            if (err instanceof Error && err.name !== 'AbortError') toast.error('Could not play preview', errorText(err));
          }
        })
        .catch((err) => {
          if (requestId !== requestRef.current) return;
          setStatus(currentRef.current ? 'paused' : 'idle');
          toast.error('No preview available', errorText(err));
        })
        .finally(() => {
          if (requestId === requestRef.current) setLoadingKey(null);
        });
    },
    [setCurrent, toast],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    requestRef.current++;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setCurrent(null);
    setStatus('idle');
    setLoadingKey(null);
    setCurrentTime(0);
  }, [setCurrent]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
  }, []);

  const setVolume = useCallback((v: number) => {
    const value = Math.min(1, Math.max(0, v));
    setVolumeState(value);
    storageSet('volume', value);
    if (audioRef.current) audioRef.current.volume = value;
  }, []);

  const value = useMemo<PlayerApi>(
    () => ({ current, status, loadingKey, play, toggle, stop }),
    [current, status, loadingKey, play, toggle, stop],
  );
  const progress = useMemo<PlayerProgressApi>(
    () => ({ volume, currentTime, duration, seek, setVolume }),
    [volume, currentTime, duration, seek, setVolume],
  );

  return (
    <PlayerContext.Provider value={value}>
      <PlayerProgressContext.Provider value={progress}>{children}</PlayerProgressContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}

export function usePlayerProgress(): PlayerProgressApi {
  const ctx = useContext(PlayerProgressContext);
  if (!ctx) throw new Error('usePlayerProgress must be used inside PlayerProvider');
  return ctx;
}
