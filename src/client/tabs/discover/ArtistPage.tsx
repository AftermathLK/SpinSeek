import { ArrowLeft, CheckSquare, ChevronDown, ExternalLink, Heart, Layers, ListChecks, MapPin, Radio, Square, Star, User } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AlbumRow } from '../../components/AlbumRow';
import type { ArtistRef } from '../../context/AppContext';
import type { GroupState } from './model';
import type { AlbumCategory, AlbumResult, ArtistProfile, Edition, SimilarArtist } from '../../../shared/types';

interface Props {
  artist: ArtistRef;
  profile: ArtistProfile | null;
  profileError: string | null;
  group: GroupState | null;
  groupError: string | null;
  selected: Map<string, AlbumResult>;
  onToggle: (album: AlbumResult) => void;
  onSelectMany: (albums: AlbumResult[], select: boolean) => void;
  onRate: (album: AlbumResult, rating: number | null) => void;
  onChooseEdition: (album: AlbumResult, edition: Edition | null) => void;
  onBack: () => void;
  /** Last.fm similar artists: null while loading, undefined when the feature is off. */
  similar?: SimilarArtist[] | null;
  onOpenSimilar: (artist: SimilarArtist) => void;
}

function SimilarArtists({ artists, onOpen }: { artists: SimilarArtist[] | null; onOpen: (a: SimilarArtist) => void }) {
  if (artists && artists.length === 0) return null;
  return (
    <section className="card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <Radio className="h-4 w-4 text-sky-400" /> Similar Artists
      </h2>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {(artists ?? Array.from({ length: 6 }, () => null)).map((a, i) =>
          a ? (
            <button
              key={a.name}
              onClick={() => onOpen(a)}
              className="group w-28 shrink-0 text-left"
              title={`Open ${a.name}'s artist page`}
            >
              <div className="mb-1.5 flex h-28 w-28 items-center justify-center overflow-hidden rounded-xl bg-zinc-800 ring-1 ring-zinc-700/60 transition group-hover:ring-sky-500/60">
                {a.imageUrl ? (
                  <img src={a.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <User className="h-8 w-8 text-zinc-600" />
                )}
              </div>
              <p className="truncate text-xs font-medium text-zinc-200 group-hover:text-sky-200">{a.name}</p>
              <p className="text-[11px] text-zinc-500">{a.match}% match</p>
            </button>
          ) : (
            <div key={i} className="w-28 shrink-0 space-y-1.5">
              <div className="skeleton h-28 w-28 rounded-xl" />
              <div className="skeleton h-3 w-20" />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

const SECTIONS: { key: AlbumCategory; label: string; open: boolean }[] = [
  { key: 'studio', label: 'Studio Albums', open: true },
  { key: 'ep', label: 'EPs', open: true },
  { key: 'live', label: 'Live', open: false },
  { key: 'compilation', label: 'Compilations', open: false },
  { key: 'single', label: 'Singles & Remixes', open: false },
  { key: 'other', label: 'Soundtracks & Other', open: false },
];

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function activeYears(lifeSpan: ArtistProfile['lifeSpan']): string | null {
  const begin = lifeSpan.begin?.slice(0, 4);
  if (!begin) return null;
  const end = lifeSpan.end?.slice(0, 4);
  return lifeSpan.ended ? `${begin} – ${end ?? '?'}` : `${begin} – present`;
}

function newestFirst(a: AlbumResult, b: AlbumResult): number {
  return (b.firstReleaseDate ?? '').localeCompare(a.firstReleaseDate ?? '') || a.title.localeCompare(b.title);
}

function Hero({ artist, profile, error }: { artist: ArtistRef; profile: ArtistProfile | null; error: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const years = profile ? activeYears(profile.lifeSpan) : null;
  const lib = profile?.library;
  return (
    <section className="card relative overflow-hidden">
      {profile?.imageUrl && (
        <div
          className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-20 blur-2xl"
          style={{ backgroundImage: `url("${profile.imageUrl}")` }}
          aria-hidden
        />
      )}
      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-start">
        <div className="flex h-36 w-36 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-zinc-800 shadow-xl shadow-black/40">
          {profile?.imageUrl ? (
            <img src={profile.imageUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : (
            <User className="h-14 w-14 text-zinc-600" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest text-zinc-400">{profile?.type ?? 'Artist'}</p>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">{profile?.name ?? artist.name}</h1>
            {profile?.disambiguation && <p className="text-sm text-zinc-400">{profile.disambiguation}</p>}
          </div>
          {profile && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-300">
              {(profile.area || profile.country) && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 text-zinc-500" />
                  {profile.area ?? profile.country}
                </span>
              )}
              {years && <span>{years}</span>}
              {profile.communityRating !== null && (
                <span className="flex items-center gap-1" title={`MusicBrainz community rating (${profile.communityVotes} votes)`}>
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  {profile.communityRating.toFixed(1)}
                </span>
              )}
              {profile.fans !== null && (
                <span className="flex items-center gap-1" title="Deezer fans">
                  <Heart className="h-3.5 w-3.5 text-rose-400" />
                  {compact.format(profile.fans)} fans
                </span>
              )}
            </div>
          )}
          {profile && profile.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.genres.map((g) => (
                <span key={g} className="pill border-zinc-700 bg-zinc-800/70 capitalize text-zinc-300">
                  {g}
                </span>
              ))}
            </div>
          )}
          {lib && (
            <p className="text-xs">
              {lib.inLidarr ? (
                <span className="pill border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                  In Lidarr · {lib.downloaded}/{lib.total} downloaded{lib.missing ? ` · ${lib.missing} missing` : ''}
                </span>
              ) : (
                <span className="pill border-zinc-700 bg-zinc-800/60 text-zinc-400">Not in Lidarr yet</span>
              )}
            </p>
          )}
          {!profile && !error && <div className="skeleton h-3 w-2/3" />}
          {error && <p className="text-xs text-amber-300">Artist details unavailable: {error}</p>}
        </div>
      </div>
      {(profile?.bio || (profile && profile.links.length > 0)) && (
        <div className="relative space-y-2 border-t border-zinc-800/80 px-5 py-4">
          {profile.bio && (
            <>
              <p className={`text-sm leading-relaxed text-zinc-300 ${expanded ? '' : 'line-clamp-3'}`}>{profile.bio}</p>
              <button className="text-xs text-violet-300 hover:underline" onClick={() => setExpanded((e) => !e)}>
                {expanded ? 'Show less' : 'Read more'}
              </button>
            </>
          )}
          {profile.links.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
              {profile.links.map((l) => (
                <a
                  key={l.label}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"
                >
                  {l.label} <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Artist page: profile + full discography by type, with bulk selection into the shared Send bar. */
export function ArtistPage(props: Props) {
  const {
    artist,
    profile,
    profileError,
    group,
    groupError,
    selected,
    onToggle,
    onSelectMany,
    onRate,
    onChooseEdition,
    onBack,
    similar,
    onOpenSimilar,
  } = props;
  const [showEditions, setShowEditions] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(SECTIONS.map((s) => [s.key, s.open])));

  const albums = useMemo(() => (group?.albums ?? []).filter((a) => showEditions || !a.isEdition), [group?.albums, showEditions]);
  const sections = useMemo(
    () =>
      SECTIONS.map((s) => ({ ...s, albums: albums.filter((a) => a.category === s.key).sort(newestFirst) })).filter(
        (s) => s.albums.length > 0,
      ),
    [albums],
  );
  const studio = albums.filter((a) => a.category === 'studio');
  const collapsedEditions = (group?.albums ?? []).filter((a) => a.isEdition).length;
  const selectedHere = albums.filter((a) => selected.has(a.mbid)).length;

  return (
    <div className="space-y-4">
      <button className="btn-ghost -ml-2" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <Hero artist={artist} profile={profile} error={profileError} />

      {similar !== undefined && <SimilarArtists artists={similar} onOpen={onOpenSimilar} />}

      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-1.5 border-b border-zinc-800/60 bg-zinc-950/90 px-4 py-2.5 backdrop-blur">
        <h2 className="mr-2 text-sm font-semibold text-zinc-200">Discography</h2>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onSelectMany(studio, true)} disabled={studio.length === 0}>
          <ListChecks className="h-3.5 w-3.5" /> Select all studio albums
        </button>
        <button
          className="btn-ghost px-2 py-1 text-xs"
          onClick={() => onSelectMany(albums.filter((a) => a.lidarrStatus !== 'downloaded' && a.category === 'studio'), true)}
          disabled={studio.length === 0}
        >
          <CheckSquare className="h-3.5 w-3.5" /> Select missing studio albums
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onSelectMany(albums, false)} disabled={selectedHere === 0}>
          <Square className="h-3.5 w-3.5" /> Deselect
        </button>
        {collapsedEditions > 0 && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" className="checkbox" checked={showEditions} onChange={(e) => setShowEditions(e.target.checked)} />
            <Layers className="h-3.5 w-3.5" /> Show deluxe & remasters ({collapsedEditions})
          </label>
        )}
      </div>

      {groupError && <p className="card p-4 text-sm text-red-300">{groupError}</p>}
      {!group && !groupError && (
        <div className="card space-y-3 p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="skeleton h-14 w-14" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-3.5 w-1/3" />
                <div className="skeleton h-3 w-1/5" />
              </div>
            </div>
          ))}
        </div>
      )}
      {group && sections.length === 0 && !groupError && (
        <p className="card p-4 text-sm text-zinc-500">MusicBrainz lists no releases for this artist.</p>
      )}

      {sections.map((s) => {
        const isOpen = open[s.key];
        const allSelected = s.albums.every((a) => selected.has(a.mbid));
        return (
          <section key={s.key} className="card overflow-hidden">
            <header className="flex items-center gap-3 border-b border-zinc-800/80 px-4 py-2.5">
              <button
                className="flex items-center gap-2 text-left text-sm font-semibold text-zinc-100"
                onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}
                aria-expanded={isOpen}
              >
                <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                {s.label}
                <span className="text-xs font-normal text-zinc-500">{s.albums.length}</span>
              </button>
              <button className="btn-ghost ml-auto px-2 py-1 text-xs" onClick={() => onSelectMany(s.albums, !allSelected)}>
                {allSelected ? 'Unselect all' : 'Select all'}
              </button>
            </header>
            {isOpen && (
              <div className="space-y-1.5 p-2 sm:p-3">
                {s.albums.map((album) => (
                  <AlbumRow
                    key={album.mbid}
                    album={album}
                    checked={selected.has(album.mbid)}
                    onToggle={onToggle}
                    onRate={onRate}
                    onChooseEdition={onChooseEdition}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
