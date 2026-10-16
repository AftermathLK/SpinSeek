import type { AiPick, AlbumCategory, AlbumResult, ResultGroup } from '../../../shared/types';

export interface GroupState extends ResultGroup {
  loading: boolean;
  collapsed: boolean;
  statusMessage: string | null;
  unresolved: { pick: AiPick; error: string }[];
  expected: number;
}

export type FilterKey = 'studio' | 'ep' | 'live' | 'compilation' | 'deluxe' | 'single' | 'other';
export type Filters = Record<FilterKey, boolean>;

export const DEFAULT_FILTERS: Filters = {
  studio: true,
  ep: false,
  live: false,
  compilation: false,
  deluxe: false,
  single: false,
  other: false,
};

export const FILTER_LABELS: { key: FilterKey; label: string }[] = [
  { key: 'studio', label: 'Studio Albums' },
  { key: 'ep', label: 'EPs' },
  { key: 'live', label: 'Live' },
  { key: 'compilation', label: 'Compilations' },
  { key: 'deluxe', label: 'Deluxe / Remastered' },
  { key: 'single', label: 'Singles & Remixes' },
  { key: 'other', label: 'Soundtracks & Other' },
];

const CATEGORY_FILTER: Record<AlbumCategory, FilterKey> = {
  studio: 'studio',
  ep: 'ep',
  live: 'live',
  compilation: 'compilation',
  single: 'single',
  other: 'other',
};

/** Pinned rows (auto-checked matches, AI picks) always show; collapsed editions need the Deluxe pill. */
export function isVisible(album: AlbumResult, filters: Filters): boolean {
  if (album.pinned) return true;
  if (album.isEdition && !filters.deluxe) return false;
  return filters[CATEGORY_FILTER[album.category]];
}

export function newGroup(base: Partial<GroupState> & Pick<ResultGroup, 'id' | 'query' | 'kind'>): GroupState {
  return {
    artist: null,
    alternatives: [],
    albums: [],
    error: null,
    notices: [],
    albumQuery: null,
    loading: false,
    collapsed: false,
    statusMessage: null,
    unresolved: [],
    expected: 0,
    ...base,
  };
}

export function fromResolved(group: ResultGroup, previous?: GroupState): GroupState {
  return {
    ...group,
    loading: false,
    collapsed: previous?.collapsed ?? false,
    statusMessage: null,
    unresolved: [],
    expected: 0,
  };
}
