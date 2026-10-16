import { Clock, Radar } from 'lucide-react';
import { memo } from 'react';
import { CoverArt } from '../../components/CoverArt';
import { PreviewButton } from '../../components/PreviewButton';
import { StarRating } from '../../components/StarRating';
import { CutoffBadge, StatusBadge } from '../../components/StatusBadge';
import { libraryTypeLabel, searchedAgoLabel, withinCooldown } from '../../lib/format';
import type { LibraryAlbum } from '../../../shared/types';

export function isSearchable(a: LibraryAlbum): boolean {
  return Boolean(a.lidarrAlbumId) && (a.status === 'missing_monitored' || (a.status === 'partial' && a.monitored) || a.cutoffUnmet);
}

interface Props {
  album: LibraryAlbum;
  checked: boolean;
  onToggle: (album: LibraryAlbum) => void;
  onRate: (album: LibraryAlbum, rating: number | null) => void;
}

function LibraryAlbumCardInner({ album, checked, onToggle, onRate }: Props) {
  const searchable = isSearchable(album);
  const cooldown = withinCooldown(album.lastSearchedAt);
  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border transition-colors ${
        checked ? 'border-violet-500/60 bg-violet-500/[0.07]' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
      }`}
    >
      <div className="relative">
        <button
          type="button"
          className="block w-full"
          onClick={() => searchable && onToggle(album)}
          tabIndex={-1}
          aria-hidden
          style={{ cursor: searchable ? 'pointer' : 'default' }}
        >
          <CoverArt
            mbid={album.albumMbid}
            artist={album.artistName}
            album={album.title}
            primaryUrl={album.coverUrl}
            className="aspect-square w-full rounded-none"
          />
        </button>
        {searchable && (
          <label className="absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-zinc-950/80 backdrop-blur">
            <input
              type="checkbox"
              className="checkbox"
              checked={checked}
              onChange={() => onToggle(album)}
              aria-label={`Select ${album.title}`}
            />
          </label>
        )}
        <div className="absolute bottom-2 right-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
          <PreviewButton previewKey={`lib-${album.albumMbid}`} artist={album.artistName} album={album.title} compact />
        </div>
        {album.queued && (
          <span className="pill absolute right-2 top-2 border-violet-500/40 bg-violet-950/90 text-violet-200">
            <Radar className="h-3 w-3 animate-pulse" /> Queued
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100" title={album.title}>
            {album.title}
          </p>
          <p className="truncate text-xs text-zinc-400" title={album.artistName}>
            {album.artistName}
            {album.year ? ` · ${album.year}` : ''}
            <span className="text-zinc-600"> · {libraryTypeLabel(album.primaryType, album.secondaryTypes)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={album.status} percent={album.percentOfTracks} />
          {album.cutoffUnmet && <CutoffBadge />}
          {cooldown && (
            <span className="pill border-zinc-700 bg-zinc-800/70 text-zinc-400" title="Searched within the last 24 hours">
              <Clock className="h-3 w-3" /> {searchedAgoLabel(album.lastSearchedAt!)}
            </span>
          )}
        </div>
        <div className="mt-auto">
          <StarRating value={album.userRating} onChange={(r) => onRate(album, r)} />
        </div>
      </div>
    </div>
  );
}

export const LibraryAlbumCard = memo(LibraryAlbumCardInner);
