import { ArrowRight, Disc3, ListMusic, Loader2, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, isAbort } from '../../lib/api';
import { quoteForQuery } from '../../../shared/parse';
import type { SuggestResponse } from '../../../shared/types';

const cache = new Map<string, SuggestResponse>();
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

interface Props {
  /** Single query to suggest for ("" = nothing to suggest). */
  query: string;
  open: boolean;
  onClose: () => void;
  onSearch: (text: string) => void;
  onOpenArtist: (name: string) => void;
}

/** Live quick results under the search box (Deezer: instant, no MusicBrainz rate limit). */
export function QuickResults({ query, open, onClose, onSearch, onOpenArtist }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ q: string; res: SuggestResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) {
      setLoading(false);
      return;
    }
    const hit = cache.get(q.toLowerCase());
    if (hit) {
      setData({ q, res: hit });
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .get<SuggestResponse>(`/api/search/suggest?q=${encodeURIComponent(q)}`, controller.signal)
        .then((res) => {
          cache.set(q.toLowerCase(), res);
          setData({ q, res });
        })
        .catch((err) => {
          if (!isAbort(err)) setData(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  // Close on outside click (clicks in the search box itself keep it open).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const container = ref.current?.parentElement;
      if (container && !container.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  const res = data && data.q === q ? data.res : null;
  const empty = !res || (res.artists.length === 0 && res.albums.length === 0);
  if (!open || q.length < 2 || (empty && !loading)) return null;

  return (
    <div
      ref={ref}
      className="absolute inset-x-0 top-full z-40 mt-1.5 animate-fade-in overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60"
      role="listbox"
    >
      {loading && !res && (
        <p className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up “{q}”…
        </p>
      )}
      {res && res.artists.length > 0 && (
        <div className="border-b border-zinc-800 py-1.5">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Artists</p>
          {res.artists.map((a) => (
            <div key={a.name} className="flex items-center gap-3 px-3 py-1.5 hover:bg-zinc-800/60">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800">
                {a.imageUrl ? (
                  <img src={a.imageUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <User className="h-4 w-4 text-zinc-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100">{a.name}</p>
                {a.fans !== null && <p className="text-[11px] text-zinc-500">{compact.format(a.fans)} fans</p>}
              </div>
              <button className="btn-secondary shrink-0 px-2 py-1 text-xs" onClick={() => onOpenArtist(a.name)}>
                Open Artist Page <ArrowRight className="h-3 w-3" />
              </button>
              <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => onSearch(quoteForQuery(a.name))}>
                <ListMusic className="h-3.5 w-3.5" /> List Albums
              </button>
            </div>
          ))}
        </div>
      )}
      {res && res.albums.length > 0 && (
        <div className="py-1.5">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Albums</p>
          {res.albums.map((a) => (
            <div key={`${a.artist}-${a.title}`} className="flex items-center gap-3 px-3 py-1.5 hover:bg-zinc-800/60">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-800">
                {a.coverUrl ? (
                  <img src={a.coverUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <Disc3 className="h-4 w-4 text-zinc-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100">{a.title}</p>
                <p className="truncate text-[11px] text-zinc-500">
                  {a.artist}
                  {a.recordType && a.recordType !== 'album' ? ` · ${a.recordType.toUpperCase()}` : ''}
                </p>
              </div>
              <button
                className="btn-secondary shrink-0 px-2 py-1 text-xs"
                onClick={() => onSearch(`${quoteForQuery(a.artist)} - ${quoteForQuery(a.title)}`)}
              >
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">Enter runs the full search · Esc closes</p>
    </div>
  );
}
