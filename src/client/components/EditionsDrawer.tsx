import { BadgeCheck, Check, Disc, Loader2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { formatDuration } from '../lib/format';
import type { Edition, EditionsResponse } from '../../shared/types';

const cache = new Map<string, EditionsResponse>();

export function editionLabel(e: Edition): string {
  const parts = [e.country, e.format].filter(Boolean).join(' ');
  return `${parts || 'Release'} – ${e.trackCount} Track${e.trackCount === 1 ? '' : 's'}`;
}

interface Props {
  mbid: string;
  /** Edition the user pinned for this album (overrides the automatic standard pick). */
  chosenMbid?: string | null;
  onChoose?: (edition: Edition | null) => void;
}

/** Lazily fetched pressings + tracklist for one release group, opening on the standard edition. */
export function EditionsDrawer({ mbid, chosenMbid, onChoose }: Props) {
  const [data, setData] = useState<EditionsResponse | null>(() => cache.get(mbid) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    const cached = cache.get(mbid);
    return chosenMbid ?? cached?.preferredMbid ?? cached?.editions[0]?.mbid ?? null;
  });

  useEffect(() => {
    if (cache.has(mbid)) return;
    let cancelled = false;
    api
      .get<EditionsResponse>(`/api/mb/release-group/${mbid}/editions`)
      .then((res) => {
        cache.set(mbid, res);
        if (cancelled) return;
        setData(res);
        setSelected((s) => s ?? chosenMbid ?? res.preferredMbid ?? res.editions[0]?.mbid ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mbid, chosenMbid]);

  if (error) return <p className="px-4 py-3 text-xs text-red-300">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading editions from MusicBrainz…
      </div>
    );
  }
  const { editions, preferredMbid, preferredLabel, totalReleases } = data;
  if (editions.length === 0) return <p className="px-4 py-3 text-xs text-zinc-500">No releases listed on MusicBrainz.</p>;

  const edition = editions.find((e) => e.mbid === selected) ?? editions[0];
  const isPreferred = edition.mbid === preferredMbid;
  const isChosen = edition.mbid === chosenMbid;
  // Chosen, then standard, first; everything else keeps its release-date order.
  const rank = (e: Edition) => (e.mbid === chosenMbid ? 0 : e.mbid === preferredMbid ? 1 : 2);
  const ordered = [...editions].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="grid gap-3 border-t border-zinc-800/80 bg-zinc-950/40 px-4 py-3 md:grid-cols-[minmax(0,17rem)_1fr]">
      <div>
        <p className="label">
          Editions ({editions.length}
          {totalReleases > editions.length ? ` of ${totalReleases}` : ''})
        </p>
        <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
          {ordered.map((e) => (
            <li key={e.mbid}>
              <button
                onClick={() => setSelected(e.mbid)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  e.mbid === edition.mbid ? 'bg-violet-500/15 text-violet-100' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {editionLabel(e)}
                  {e.mbid === preferredMbid && (
                    <span className="pill border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-300">Standard</span>
                  )}
                  {e.mbid === chosenMbid && (
                    <span className="pill border-violet-500/40 bg-violet-500/15 px-1.5 py-0 text-[10px] text-violet-200">Chosen</span>
                  )}
                </span>
                <span className="block text-[10px] text-zinc-500">
                  {[e.date, e.status, e.disambiguation].filter(Boolean).join(' · ') || e.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="label mb-0">
            Tracklist · {edition.title}
            {edition.disambiguation ? ` (${edition.disambiguation})` : ''}
          </p>
          {onChoose && (
            <div className="flex items-center gap-1.5">
              {isChosen ? (
                <>
                  <span className="flex items-center gap-1 text-[11px] text-violet-200">
                    <Check className="h-3 w-3" /> Lidarr will use this edition
                  </span>
                  <button className="btn-ghost px-1.5 py-0.5 text-[11px]" onClick={() => onChoose(null)}>
                    <Undo2 className="h-3 w-3" /> Automatic
                  </button>
                </>
              ) : isPreferred && !chosenMbid ? (
                <span className="flex items-center gap-1 text-[11px] text-emerald-300" title={preferredLabel ?? undefined}>
                  <BadgeCheck className="h-3 w-3" /> Auto-selected standard edition
                </span>
              ) : (
                <button className="btn-secondary px-2 py-0.5 text-[11px]" onClick={() => onChoose(edition)}>
                  Use this edition
                </button>
              )}
            </div>
          )}
        </div>
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {edition.media.map((m) => (
            <div key={m.position}>
              {edition.media.length > 1 && (
                <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  <Disc className="h-3 w-3" /> {m.format || 'Disc'} {m.position}
                  {m.title ? ` – ${m.title}` : ''}
                </p>
              )}
              <ol className="space-y-0.5">
                {m.tracks.map((t, i) => (
                  <li key={`${m.position}-${i}`} className="flex gap-2 text-xs">
                    <span className="w-6 shrink-0 text-right tabular-nums text-zinc-600">{t.number}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-300">{t.title}</span>
                    <span className="shrink-0 tabular-nums text-zinc-500">{formatDuration(t.lengthMs)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
