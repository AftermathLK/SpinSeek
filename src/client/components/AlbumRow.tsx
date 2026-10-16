import { ChevronDown, Disc, Flame, Layers, Radio, Sparkles, Star } from 'lucide-react';
import { memo, useState } from 'react';
import { useDeezerInfo } from '../lib/deezer';
import { searchedAgoLabel, typeLabel, withinCooldown } from '../lib/format';
import { CoverArt } from './CoverArt';
import { EditionsDrawer } from './EditionsDrawer';
import { PreviewButton } from './PreviewButton';
import { StarRating } from './StarRating';
import { CutoffBadge, StatusBadge, statusLabel } from './StatusBadge';
import type { AlbumResult, Edition } from '../../shared/types';

interface Props {
  album: AlbumResult;
  checked: boolean;
  onToggle: (album: AlbumResult) => void;
  onRate: (album: AlbumResult, rating: number | null) => void;
  onChooseEdition?: (album: AlbumResult, edition: Edition | null) => void;
  /** When set, the artist name links to the artist page. */
  onOpenArtist?: (album: AlbumResult) => void;
}

const TYPE_STYLES: Record<string, string> = {
  studio: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  ep: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  live: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  compilation: 'border-lime-500/30 bg-lime-500/10 text-lime-300',
  single: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300',
  other: 'border-zinc-600 bg-zinc-800 text-zinc-300',
};

function AlbumRowInner({ album, checked, onToggle, onRate, onChooseEdition, onOpenArtist }: Props) {
  const [open, setOpen] = useState(false);
  const { ref, info } = useDeezerInfo(album.artistName, album.title);

  const meta = (
    <>
      <PreviewButton previewKey={album.mbid} artist={album.artistName} album={album.title} />
      <span
        className="pill border-zinc-700 bg-zinc-800/60 text-zinc-300"
        title={album.communityRating ? `MusicBrainz community rating (${album.communityVotes} votes)` : 'No MusicBrainz rating yet'}
      >
        <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
        {album.communityRating !== null ? album.communityRating.toFixed(1) : '–'}
      </span>
      {info?.popularity !== null && info?.popularity !== undefined && (
        <span className="pill border-orange-500/30 bg-orange-500/10 text-orange-300" title="Deezer popularity (top track rank)">
          <Flame className="h-3 w-3" />
          {info.popularity}
        </span>
      )}
      <StarRating value={album.userRating} onChange={(r) => onRate(album, r)} />
      <StatusBadge status={album.lidarrStatus} />
      {album.cutoffUnmet && <CutoffBadge />}
      {withinCooldown(album.lastSearchedAt) && (
        <span className="pill border-zinc-700 bg-zinc-800/60 text-zinc-400">{searchedAgoLabel(album.lastSearchedAt!)}</span>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-expanded={open}
      >
        Editions / Tracks
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </>
  );

  return (
    <div
      ref={ref}
      className={`overflow-hidden rounded-lg border transition-colors ${
        checked ? 'border-violet-500/50 bg-violet-500/[0.06]' : 'border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <input
          type="checkbox"
          className="checkbox mt-5 shrink-0"
          checked={checked}
          onChange={() => onToggle(album)}
          aria-label={`Select ${album.title}`}
        />
        <button type="button" className="shrink-0" onClick={() => onToggle(album)} tabIndex={-1} aria-hidden>
          <CoverArt mbid={album.mbid} artist={album.artistName} album={album.title} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 cursor-pointer" onClick={() => onToggle(album)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium text-zinc-100" title={album.title}>
                  {album.title}
                </span>
                <span className={`pill ${TYPE_STYLES[album.category] ?? TYPE_STYLES.other}`}>
                  {typeLabel(album.category, album.primaryType, album.secondaryTypes)}
                </span>
                {album.isEditionTitle && <span className="pill border-zinc-700 bg-zinc-800 text-zinc-400">Edition</span>}
                {album.releaseLabel && (
                  <span className="pill border-violet-500/40 bg-violet-500/10 text-violet-200" title="Lidarr will monitor this edition">
                    <Disc className="h-3 w-3" />
                    {album.releaseLabel}
                  </span>
                )}
                {album.collapsedEditions.length > 0 && (
                  <span
                    className="pill border-zinc-700 bg-zinc-800 text-zinc-400"
                    title={album.collapsedEditions.map((e) => `${e.title}${e.year ? ` (${e.year})` : ''}`).join('\n')}
                  >
                    <Layers className="h-3 w-3" />+{album.collapsedEditions.length}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-400">
                {onOpenArtist && album.artistMbid ? (
                  <button
                    type="button"
                    className="hover:text-violet-200 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenArtist(album);
                    }}
                    title="Open artist page"
                  >
                    {album.artistName}
                  </button>
                ) : (
                  album.artistName
                )}
                {album.year ? ` · ${album.year}` : ''}
              </p>
              {album.editionLibraryStatus && album.editionLibraryStatus !== 'not_in_lidarr' && album.lidarrStatus === 'not_in_lidarr' && (
                <p className="mt-0.5 text-[11px] text-sky-300/80">Another edition is in Lidarr ({statusLabel(album.editionLibraryStatus)})</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">{meta}</div>
          </div>
          {album.reason &&
            (album.source === 'recs' ? (
              <p className="mt-1.5 flex gap-1.5 text-xs text-sky-200/85">
                <Radio className="mt-0.5 h-3 w-3 shrink-0 text-sky-400" />
                {album.reason}
              </p>
            ) : (
              <p className="mt-1.5 flex gap-1.5 text-xs italic text-violet-200/80">
                <Sparkles className="mt-0.5 h-3 w-3 shrink-0 not-italic text-violet-400" />
                {album.reason}
              </p>
            ))}
        </div>
      </div>
      {open && (
        <EditionsDrawer
          mbid={album.mbid}
          chosenMbid={album.releaseMbid ?? null}
          onChoose={onChooseEdition ? (edition) => onChooseEdition(album, edition) : undefined}
        />
      )}
    </div>
  );
}

export const AlbumRow = memo(AlbumRowInner);
