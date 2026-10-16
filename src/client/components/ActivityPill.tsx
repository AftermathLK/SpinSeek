import { AlertCircle, CheckCircle2, Download, Loader2, Pause, Play, Radar, Trash2, UserPlus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { api, errorText } from '../lib/api';
import { formatBytes, timeAgo } from '../lib/format';
import type { DripStatus, LidarrQueueResponse } from '../../shared/types';

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Live Activity: Spin Seek drip queue + Lidarr download queue, with a details popover. */
export function ActivityPill() {
  const { activityVersion, bumpLibrary, settings } = useApp();
  const toast = useToast();
  const visible = useVisible();
  const [open, setOpen] = useState(false);
  const [drip, setDrip] = useState<DripStatus | null>(null);
  const [queue, setQueue] = useState<LidarrQueueResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevDripActive = useRef(false);

  const dripActive = Boolean(drip && drip.pending + drip.processing > 0);
  const pendingAdds = drip?.pendingAdds ?? [];
  const waitingAdds = pendingAdds.filter((j) => j.state === 'waiting').length;
  const anyActive = dripActive || waitingAdds > 0;
  const downloads = queue?.items.length ?? 0;
  const now = useNow(1000, open && dripActive);

  const loadDrip = useCallback(async () => {
    try {
      const status = await api.get<DripStatus>('/api/drip/status');
      setDrip(status);
      const active = status.pending + status.processing > 0 || (status.pendingAdds ?? []).some((j) => j.state === 'waiting');
      // Queue just drained: refresh library badges ("Searched Xh ago").
      if (prevDripActive.current && !active) bumpLibrary();
      prevDripActive.current = active;
    } catch {
      // keep the last known state
    }
  }, [bumpLibrary]);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.get<LidarrQueueResponse>('/api/lidarr/queue'));
    } catch {
      // keep the last known state
    }
  }, []);

  // Drip queue: fast poll while active, slow when idle.
  useEffect(() => {
    if (!visible) return;
    void loadDrip();
    const id = window.setInterval(loadDrip, anyActive ? 3000 : 15000);
    return () => window.clearInterval(id);
  }, [visible, anyActive, loadDrip, activityVersion]);

  // Lidarr queue: every 10s while there is activity (or the popover is open), 30s otherwise.
  useEffect(() => {
    if (!visible || !settings?.lidarrConfigured) return;
    void loadQueue();
    const id = window.setInterval(loadQueue, downloads > 0 || open ? 10000 : 30000);
    return () => window.clearInterval(id);
  }, [visible, downloads, open, loadQueue, activityVersion, settings?.lidarrConfigured]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const togglePause = async () => {
    if (!drip) return;
    setBusy(true);
    try {
      setDrip(await api.post<DripStatus>('/api/drip/pause', { paused: !drip.paused }));
    } catch (err) {
      toast.error('Could not update the drip queue', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clearQueue = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ removed: number; status: DripStatus }>('/api/drip/clear');
      setDrip(res.status);
      bumpLibrary();
      toast.info(`Removed ${res.removed} pending search${res.removed === 1 ? '' : 'es'} from the drip queue`);
    } catch (err) {
      toast.error('Could not clear the drip queue', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const avgProgress = downloads > 0 ? Math.round(queue!.items.reduce((s, i) => s + i.progress, 0) / downloads) : 0;
  const nextIn = drip?.nextRunAt ? Math.max(0, Math.round((drip.nextRunAt - now) / 1000)) : null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          anyActive || downloads > 0
            ? 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'
            : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
        }`}
        aria-expanded={open}
      >
        {waitingAdds > 0 && (
          <span className="flex items-center gap-1.5" title="Waiting for Lidarr to import new artists, then searching">
            <UserPlus className="h-3.5 w-3.5 animate-pulse" />
            <span className="hidden sm:inline">
              Adding {waitingAdds} artist{waitingAdds === 1 ? '' : 's'}…
            </span>
          </span>
        )}
        {waitingAdds > 0 && (dripActive || downloads > 0) && <span className="h-3 w-px bg-violet-500/40" />}
        {dripActive ? (
          <span className="flex items-center gap-1.5">
            {drip?.paused ? <Pause className="h-3.5 w-3.5" /> : <Radar className="h-3.5 w-3.5 animate-pulse" />}
            <span className="hidden sm:inline">{drip?.paused ? 'Queue paused' : 'Searching Queue:'}</span>
            <span className="tabular-nums">
              {drip?.done ?? 0}/{drip?.total ?? 0}
            </span>
          </span>
        ) : null}
        {dripActive && downloads > 0 && <span className="h-3 w-px bg-violet-500/40" />}
        {downloads > 0 ? (
          <span className="flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" />
            <span className="tabular-nums">
              {downloads}
              <span className="hidden sm:inline"> · {avgProgress}%</span>
            </span>
          </span>
        ) : null}
        {!anyActive && downloads === 0 && (
          <span className="flex items-center gap-1.5">
            {queue?.error ? <AlertCircle className="h-3.5 w-3.5 text-amber-400" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">Idle</span>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(26rem,calc(100vw-1.5rem))] animate-fade-in overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/60">
          {pendingAdds.length > 0 && (
            <section className="border-b border-zinc-800 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <UserPlus className="h-4 w-4 text-emerald-400" /> New Artists
              </h3>
              <ul className="space-y-1.5">
                {pendingAdds.map((job) => (
                  <li key={job.artistId} className="flex items-start gap-2 text-xs">
                    {job.state === 'waiting' ? (
                      <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-violet-400" />
                    ) : job.state === 'done' ? (
                      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                    ) : (
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                    )}
                    <span className="min-w-0">
                      <span className="text-zinc-200">{job.artistName}</span>
                      <span className="block text-[11px] text-zinc-500">{job.message}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{timeAgo(job.finishedAt ?? job.startedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="border-b border-zinc-800 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Radar className="h-4 w-4 text-violet-400" /> Drip Search Queue
              </h3>
              <div className="flex gap-1">
                <button className="btn-secondary px-2 py-1 text-xs" onClick={togglePause} disabled={busy || !drip}>
                  {drip?.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {drip?.paused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn-danger px-2 py-1 text-xs" onClick={clearQueue} disabled={busy || !drip?.pending}>
                  <Trash2 className="h-3.5 w-3.5" /> Clear
                </button>
              </div>
            </div>
            {drip && (
              <>
                <p className="text-xs text-zinc-400">
                  {dripActive
                    ? `${drip.done} of ${drip.total} searched${drip.failed ? ` · ${drip.failed} failed` : ''} · ${drip.pending} pending`
                    : 'Queue is empty.'}{' '}
                  {dripActive && !drip.paused && nextIn !== null && <>· next batch in {nextIn}s</>}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {drip.batchSize} album{drip.batchSize === 1 ? '' : 's'} every {drip.intervalSec}s (indexer-safe)
                </p>
                {drip.total > 0 && dripActive && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-violet-500 transition-all"
                      style={{ width: `${Math.round(((drip.done + drip.failed) / Math.max(1, drip.total)) * 100)}%` }}
                    />
                  </div>
                )}
                {drip.upcoming.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {drip.upcoming.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 text-xs">
                        {item.status === 'processing' ? (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-violet-400" />
                        ) : (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                        )}
                        <span className="truncate text-zinc-300">
                          {item.artistName} – {item.albumTitle}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {drip.recent.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">Recently searched</summary>
                    <ul className="mt-1.5 space-y-1">
                      {drip.recent.map((item) => (
                        <li key={item.id} className="flex items-center gap-2 text-xs" title={item.error ?? undefined}>
                          {item.status === 'failed' ? (
                            <XCircle className="h-3 w-3 shrink-0 text-red-400" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                          )}
                          <span className="truncate text-zinc-400">
                            {item.artistName} – {item.albumTitle}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{timeAgo(item.processedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </section>
          <section className="max-h-80 overflow-y-auto p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Download className="h-4 w-4 text-sky-400" /> Lidarr Downloads
              {queue && queue.total > 0 && <span className="text-xs font-normal text-zinc-500">({queue.total})</span>}
            </h3>
            {!settings?.lidarrConfigured && <p className="text-xs text-zinc-500">Connect Lidarr in Settings to see downloads.</p>}
            {queue?.error && <p className="text-xs text-amber-300">{queue.error}</p>}
            {settings?.lidarrConfigured && queue && !queue.error && queue.items.length === 0 && (
              <p className="text-xs text-zinc-500">Nothing downloading right now.</p>
            )}
            <ul className="space-y-3">
              {queue?.items.map((item) => (
                <li key={item.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-xs font-medium text-zinc-200">
                      {item.artistName && item.albumTitle ? `${item.artistName} – ${item.albumTitle}` : item.title}
                    </p>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{Math.round(item.progress)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full transition-all ${item.errorMessage ? 'bg-amber-500' : 'bg-sky-500'}`}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                  <p className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-zinc-500">
                    <span className="capitalize">{item.trackedDownloadState || item.status}</span>
                    {item.size > 0 && (
                      <span>
                        {formatBytes(item.size - item.sizeLeft)} / {formatBytes(item.size)}
                      </span>
                    )}
                    {item.timeLeft && <span>{item.timeLeft} left</span>}
                    {item.downloadClient && <span>{item.downloadClient}</span>}
                  </p>
                  {item.errorMessage && <p className="mt-0.5 text-[10px] text-amber-400">{item.errorMessage}</p>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
