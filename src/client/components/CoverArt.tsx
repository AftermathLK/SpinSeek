import { Disc3 } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { coverArtArchiveUrl, deezerArtworkUrl } from '../lib/format';

interface Props {
  mbid: string;
  artist: string;
  album: string;
  /** Preferred source (e.g. Lidarr's remote cover); falls back to CAA then Deezer. */
  primaryUrl?: string | null;
  className?: string;
}

/** Cover Art Archive first, automatic Deezer artwork fallback, then a vinyl placeholder. */
function CoverArtInner({ mbid, artist, album, primaryUrl, className = 'h-14 w-14' }: Props) {
  const sources = useMemo(
    () => [primaryUrl, coverArtArchiveUrl(mbid), deezerArtworkUrl(artist, album)].filter((s): s is string => Boolean(s)),
    [primaryUrl, mbid, artist, album],
  );
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setIndex(0);
    setLoaded(false);
  }, [sources]);

  const src = sources[index];
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-md bg-zinc-800 ${className}`}>
      {(!src || !loaded) && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
          <Disc3 className="h-1/2 w-1/2" />
        </div>
      )}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setIndex((i) => i + 1);
          }}
        />
      )}
    </div>
  );
}

export const CoverArt = memo(CoverArtInner);
