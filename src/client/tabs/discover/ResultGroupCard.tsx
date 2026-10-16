import { AlertTriangle, ChevronDown, Disc3, Library, Loader2, Radio, Sparkles, User, UserRound, X } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { AlbumRow } from '../../components/AlbumRow';
import { isVisible, type Filters, type GroupState } from './model';
import type { AlbumResult, Edition } from '../../../shared/types';

interface Props {
  group: GroupState;
  filters: Filters;
  selected: Map<string, AlbumResult>;
  onToggle: (album: AlbumResult) => void;
  onRate: (album: AlbumResult, rating: number | null) => void;
  onChooseEdition: (album: AlbumResult, edition: Edition | null) => void;
  onOpenArtist: (album: AlbumResult) => void;
  onOpenArtistPage: (mbid: string, name: string) => void;
  onSelectMany: (albums: AlbumResult[], select: boolean) => void;
  onSwitchArtist: (groupId: string, artistMbid: string) => void;
  onCollapse: (groupId: string) => void;
  onRemove: (groupId: string) => void;
}

function SkeletonRows() {
  return (
    <div className="space-y-2 p-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-4 w-4" />
          <div className="skeleton h-14 w-14" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-1/3" />
            <div className="skeleton h-3 w-1/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultGroupCardInner({
  group,
  filters,
  selected,
  onToggle,
  onRate,
  onChooseEdition,
  onOpenArtist,
  onOpenArtistPage,
  onSelectMany,
  onSwitchArtist,
  onCollapse,
  onRemove,
}: Props) {
  const [showOwned, setShowOwned] = useState(false);
  // AI picks and recommendations: albums you already have are hidden unless "Show owned" is on.
  const curated = group.kind === 'ai' || group.kind === 'recs';
  const owned = curated ? group.albums.filter((a) => a.alreadyOwned) : [];
  const visible = useMemo(
    () => group.albums.filter((a) => isVisible(a, filters) && (showOwned || !a.alreadyOwned)),
    [group.albums, filters, showOwned],
  );
  const hidden = group.albums.length - visible.length - (showOwned ? 0 : owned.length);
  const allVisibleSelected = visible.length > 0 && visible.every((a) => selected.has(a.mbid));
  const Icon = group.kind === 'ai' ? Sparkles : group.kind === 'recs' ? Radio : group.kind === 'album' ? Disc3 : User;
  const iconColor = group.kind === 'ai' ? 'text-fuchsia-400' : group.kind === 'recs' ? 'text-sky-400' : 'text-violet-400';

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-800/80 px-3 py-2.5 sm:px-4">
        <button
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => onCollapse(group.id)}
          aria-expanded={!group.collapsed}
        >
          <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${group.collapsed ? '-rotate-90' : ''}`} />
          <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-zinc-100">
              {curated ? (group.title ?? 'AI Picks') : (group.artist?.name ?? group.query)}
              {group.artist?.disambiguation && !curated && (
                <span className="ml-1.5 text-xs font-normal text-zinc-500">({group.artist.disambiguation})</span>
              )}
            </span>
            <span className="block truncate text-[11px] text-zinc-500">
              {group.kind === 'ai' ? `“${group.query}”` : group.kind === 'recs' ? group.query : `Search: ${group.query}`}
              {group.artist?.country && group.kind === 'artist' ? ` · ${group.artist.country}` : ''}
            </span>
          </span>
        </button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {owned.length > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400" title="Albums already downloaded in Lidarr">
              <input type="checkbox" className="checkbox" checked={showOwned} onChange={(e) => setShowOwned(e.target.checked)} />
              Show owned ({owned.length})
            </label>
          )}
          {!curated && group.artist && !group.loading && (
            <button
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => onOpenArtistPage(group.artist!.mbid, group.artist!.name)}
              title="Bio, genres and full discography"
            >
              <UserRound className="h-3.5 w-3.5" /> Artist page
            </button>
          )}
          {group.alternatives.length > 0 && group.artist && (
            <select
              className="select w-auto max-w-[14rem] py-1 text-xs"
              value=""
              onChange={(e) => e.target.value && onSwitchArtist(group.id, e.target.value)}
              title="Wrong artist? Pick another match"
            >
              <option value="">Not the right artist?</option>
              {group.alternatives.map((alt) => (
                <option key={alt.mbid} value={alt.mbid}>
                  {alt.name}
                  {alt.disambiguation ? ` (${alt.disambiguation})` : ''}
                  {alt.country ? ` · ${alt.country}` : ''}
                </option>
              ))}
            </select>
          )}
          {group.kind === 'album' && group.artist && !group.loading && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onSwitchArtist(group.id, group.artist!.mbid)}>
              <Library className="h-3.5 w-3.5" /> Full discography
            </button>
          )}
          {visible.length > 0 && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onSelectMany(visible, !allVisibleSelected)}>
              {allVisibleSelected ? 'Unselect group' : 'Select group'}
            </button>
          )}
          <span className="text-[11px] tabular-nums text-zinc-500">
            {group.loading && !curated ? '…' : `${visible.length}${hidden > 0 ? ` (+${hidden} hidden)` : ''}`}
          </span>
          <button className="btn-ghost p-1" onClick={() => onRemove(group.id)} aria-label="Remove group" title="Remove">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {!group.collapsed && (
        <div>
          {group.statusMessage && (
            <p className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-2 text-xs text-zinc-400">
              {group.loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {group.statusMessage}
            </p>
          )}
          {group.loading && group.albums.length === 0 && <SkeletonRows />}
          {group.error && (
            <p className="flex items-center gap-2 px-4 py-3 text-sm text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {group.error}
            </p>
          )}
          {group.notices.map((n) => (
            <p key={n} className="px-4 py-2 text-xs text-zinc-500">
              {n}
            </p>
          ))}
          {visible.length > 0 && (
            <div className="space-y-1.5 p-2 sm:p-3">
              {visible.map((album) => (
                <AlbumRow
                  key={album.mbid}
                  album={album}
                  checked={selected.has(album.mbid)}
                  onToggle={onToggle}
                  onRate={onRate}
                  onChooseEdition={onChooseEdition}
                  onOpenArtist={onOpenArtist}
                />
              ))}
            </div>
          )}
          {!curated && !group.loading && !group.error && group.albums.length > 0 && visible.length === 0 && (
            <p className="px-4 py-3 text-xs text-zinc-500">All {group.albums.length} releases are hidden by the filter pills above.</p>
          )}
          {group.loading && curated && group.albums.length > 0 && <SkeletonRows />}
          {!group.loading && curated && owned.length > 0 && visible.length === 0 && !showOwned && (
            <p className="px-4 py-3 text-xs text-zinc-500">
              Every pick is already in your library. Tick “Show owned” to see them.
            </p>
          )}
          {group.unresolved.length > 0 && (
            <details className="border-t border-zinc-800/60 px-4 py-2">
              <summary className="cursor-pointer text-xs text-amber-300/80">
                {group.unresolved.length} pick{group.unresolved.length === 1 ? '' : 's'} couldn't be verified on MusicBrainz
              </summary>
              <ul className="mt-2 space-y-1">
                {group.unresolved.map(({ pick, error }) => (
                  <li key={`${pick.artist}-${pick.album}`} className="text-xs text-zinc-400">
                    <span className="text-zinc-300">
                      {pick.artist} – {pick.album}
                    </span>
                    {pick.year ? ` (${pick.year})` : ''} <span className="text-zinc-600">· {error}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export const ResultGroupCard = memo(ResultGroupCardInner);
