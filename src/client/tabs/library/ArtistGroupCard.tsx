import { ChevronDown, Disc3, Loader2, UserRound } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { api, errorText } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { LibraryAlbumCard, isSearchable } from './LibraryAlbumCard';
import type { LibraryAlbum, LibraryAlbumsResponse, LibraryArtist, LibraryFilter } from '../../../shared/types';

interface Props {
  artist: LibraryArtist;
  filter: LibraryFilter;
  q: string;
  version: number;
  selected: Map<string, LibraryAlbum>;
  onToggle: (album: LibraryAlbum) => void;
  onSelectMany: (albums: LibraryAlbum[], select: boolean) => void;
  onRate: (album: LibraryAlbum, rating: number | null) => void;
  onOpenArtist: (mbid: string, name: string) => void;
  patches: Map<string, Partial<LibraryAlbum>>;
}

function ArtistThumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-800 text-zinc-600">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Disc3 className="h-5 w-5" />
      )}
    </div>
  );
}

/** Expandable artist card (Group by Artist view) that lazily loads its albums. */
function ArtistGroupCardInner({ artist, filter, q, version, selected, onToggle, onSelectMany, onRate, onOpenArtist, patches }: Props) {
  const [open, setOpen] = useState(false);
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    const params = new URLSearchParams({ artistMbid: artist.artistMbid, filter, q, sort: 'oldest', limit: '1000' });
    api
      .get<LibraryAlbumsResponse>(`/api/library/albums?${params}`)
      .then((res) => {
        if (!cancelled) setAlbums(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, artist.artistMbid, filter, q, version]);

  const shown = albums?.map((a) => (patches.has(a.albumMbid) ? { ...a, ...patches.get(a.albumMbid) } : a)) ?? null;
  const searchable = shown?.filter(isSearchable) ?? [];
  const allSelected = searchable.length > 0 && searchable.every((a) => selected.has(a.albumMbid));
  const missingTotal = artist.missing;

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center hover:bg-zinc-800/30">
      <button className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen((o) => !o)}>
        <ArtistThumb url={artist.coverUrl} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-100">
            {artist.name}
            {!artist.monitored && <span className="ml-2 text-[11px] font-normal text-sky-300/80">unmonitored</span>}
          </p>
          <p className="flex flex-wrap gap-x-2 text-xs text-zinc-500">
            <span className="text-emerald-300/90">{artist.downloaded} owned</span>
            {missingTotal > 0 && <span className="text-amber-300/90">{missingTotal} missing</span>}
            {artist.cutoff > 0 && <span className="text-orange-300/90">{artist.cutoff} cutoff unmet</span>}
            <span>{artist.total} total</span>
            {artist.sizeOnDisk > 0 && <span>{formatBytes(artist.sizeOnDisk)}</span>}
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <button
        className="btn-ghost mr-2 shrink-0 px-2 py-1 text-xs"
        onClick={() => onOpenArtist(artist.artistMbid, artist.name)}
        title="Bio and full discography (add more albums)"
      >
        <UserRound className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Artist page</span>
      </button>
      </div>
      {open && (
        <div className="border-t border-zinc-800/80 p-3">
          {error && <p className="text-xs text-red-300">{error}</p>}
          {!shown && !error && (
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading albums…
            </p>
          )}
          {searchable.length > 0 && (
            <button className="btn-ghost mb-2 px-2 py-1 text-xs" onClick={() => onSelectMany(searchable, !allSelected)}>
              {allSelected ? 'Unselect' : 'Select'} {searchable.length} missing / cutoff
            </button>
          )}
          {shown && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {shown.map((album) => (
                <LibraryAlbumCard
                  key={album.albumMbid}
                  album={album}
                  checked={selected.has(album.albumMbid)}
                  onToggle={onToggle}
                  onRate={onRate}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const ArtistGroupCard = memo(ArtistGroupCardInner);
