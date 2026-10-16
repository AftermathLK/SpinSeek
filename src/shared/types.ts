// Types shared between the Express API and the React client.

export type LidarrStatus = 'downloaded' | 'missing_monitored' | 'unmonitored' | 'partial' | 'not_in_lidarr';

export type AlbumCategory = 'studio' | 'ep' | 'live' | 'compilation' | 'single' | 'other';

export interface CollapsedEdition {
  mbid: string;
  title: string;
  year: number | null;
}

export interface AlbumResult {
  /** MusicBrainz release-group MBID (== Lidarr foreignAlbumId). */
  mbid: string;
  title: string;
  artistName: string;
  artistMbid: string;
  year: number | null;
  firstReleaseDate: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  category: AlbumCategory;
  /** Title carries a deluxe/remaster/anniversary qualifier. */
  isEditionTitle: boolean;
  /** Collapsed duplicate of another (canonical) release group in the same result list. */
  isEdition: boolean;
  canonicalMbid: string | null;
  collapsedEditions: CollapsedEdition[];
  /** Best Lidarr status among collapsed editions (e.g. you own the deluxe). */
  editionLibraryStatus: LidarrStatus | null;
  communityRating: number | null;
  communityVotes: number;
  lidarrStatus: LidarrStatus;
  lidarrAlbumId: number | null;
  cutoffUnmet: boolean;
  lastSearchedAt: number | null;
  userRating: number | null;
  /** AI pitch / recommendation reason ("Because you like …"). */
  reason?: string;
  source?: 'ai' | 'recs';
  /** Always visible regardless of filter pills (auto-checked / AI picks). */
  pinned?: boolean;
  autoCheck?: boolean;
  alreadyOwned?: boolean;
  /** Edition chosen in the Editions drawer (MusicBrainz release MBID) to use instead of the auto pick. */
  releaseMbid?: string;
  releaseLabel?: string;
}

export interface ArtistSummary {
  mbid: string;
  name: string;
  disambiguation: string | null;
  country: string | null;
  type: string | null;
  score?: number;
}

export type ResultGroupKind = 'artist' | 'album' | 'ai' | 'recs';

export interface ResultGroup {
  id: string;
  query: string;
  kind: ResultGroupKind;
  /** Header title for curated groups (AI / recommendations). */
  title?: string | null;
  artist: ArtistSummary | null;
  alternatives: ArtistSummary[];
  albums: AlbumResult[];
  error: string | null;
  notices: string[];
  albumQuery: string | null;
}

export type BatchEvent =
  | { type: 'start'; groups: { id: string; query: string; kind: ResultGroupKind }[] }
  | { type: 'group'; group: ResultGroup }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface AiPick {
  artist: string;
  album: string;
  year: number | null;
  reason: string;
}

export type AiEvent =
  | { type: 'status'; message: string }
  | { type: 'picks'; picks: AiPick[] }
  | { type: 'album'; index: number; album: AlbumResult }
  | { type: 'unresolved'; index: number; pick: AiPick; error: string }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface AiDiscoverRequest {
  prompt: string;
  count: number;
  includeOwned: boolean;
  newArtistsOnly: boolean;
}

export interface EditionTrack {
  number: string;
  title: string;
  lengthMs: number | null;
}

export interface EditionMedium {
  position: number;
  format: string | null;
  title: string | null;
  tracks: EditionTrack[];
}

export interface Edition {
  mbid: string;
  title: string;
  disambiguation: string | null;
  date: string | null;
  country: string | null;
  countries: string[];
  status: string | null;
  format: string;
  trackCount: number;
  media: EditionMedium[];
}

export interface EditionsResponse {
  editions: Edition[];
  /** The standard edition Spin Seek would pick (preferred country, usual track count, no deluxe). */
  preferredMbid: string | null;
  preferredLabel: string | null;
  totalReleases: number;
}

export interface SelectReleaseResponse {
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace: number | null;
}

export interface QualityProfile {
  id: number;
  name: string;
}

export interface MetadataProfileSummary {
  id: number;
  name: string;
  primaryTypes: string[];
  secondaryTypes: string[];
}

export interface LidarrProfiles {
  rootFolders: RootFolder[];
  qualityProfiles: QualityProfile[];
  metadataProfiles: MetadataProfileSummary[];
}

export interface AddAlbumInput {
  mbid: string;
  title: string;
  artistMbid: string;
  artistName: string;
  year: number | null;
  primaryType: string | null;
  secondaryTypes: string[];
  /** Specific edition (MusicBrainz release MBID) to monitor in Lidarr. */
  releaseMbid?: string | null;
}

export interface PreflightRequest {
  albums: AddAlbumInput[];
  metadataProfileId: number;
}

export interface PreflightConflict {
  mbid: string;
  title: string;
  artistName: string;
  missingTypes: string[];
  existingArtist: boolean;
  profileName: string;
}

export interface PreflightResponse {
  conflicts: PreflightConflict[];
  suggestedProfile: { id: number; name: string } | null;
}

export interface AddRequest {
  albums: AddAlbumInput[];
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
  monitorEntireArtist: boolean;
  usePermissiveProfile: boolean;
}

export interface AddArtistResult {
  artistName: string;
  artistMbid: string;
  action: 'added_artist' | 'updated_artist';
  albumCount: number;
  ok: boolean;
  error: string | null;
}

export interface AddResponse {
  results: AddArtistResult[];
  warnings: string[];
  addedMbids: string[];
  /** Albums whose monitored edition Spin Seek switched (existing artists). */
  editionsSet: number;
  /** New artists: Spin Seek searches (after picking editions) once Lidarr finishes importing them. */
  searchPending: boolean;
}

/** Background follow-up for a newly added artist: wait for Lidarr's import, set editions, search. */
export interface PendingAdd {
  artistId: number;
  artistName: string;
  albumCount: number;
  state: 'waiting' | 'done' | 'failed';
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ArtistLink {
  label: string;
  url: string;
}

export interface ArtistProfile {
  mbid: string;
  name: string;
  disambiguation: string | null;
  type: string | null;
  country: string | null;
  area: string | null;
  lifeSpan: { begin: string | null; end: string | null; ended: boolean };
  genres: string[];
  communityRating: number | null;
  communityVotes: number;
  /** Short Wikipedia summary. */
  bio: string | null;
  wikipediaUrl: string | null;
  imageUrl: string | null;
  fans: number | null;
  links: ArtistLink[];
  library: { inLidarr: boolean; total: number; downloaded: number; missing: number; sizeOnDisk: number };
}

export interface LibraryAlbum {
  albumMbid: string;
  lidarrAlbumId: number | null;
  artistMbid: string;
  artistName: string;
  title: string;
  year: number | null;
  primaryType: string | null;
  secondaryTypes: string[];
  monitored: boolean;
  status: Exclude<LidarrStatus, 'not_in_lidarr'>;
  percentOfTracks: number;
  cutoffUnmet: boolean;
  coverUrl: string | null;
  lastSearchedAt: number | null;
  userRating: number | null;
  queued: boolean;
}

export interface LibraryArtist {
  artistMbid: string;
  name: string;
  lidarrId: number | null;
  monitored: boolean;
  total: number;
  downloaded: number;
  missing: number;
  partial: number;
  cutoff: number;
  sizeOnDisk: number;
  coverUrl: string | null;
}

export type LibraryFilter = 'all' | 'downloaded' | 'missing' | 'cutoff' | 'unmonitored' | 'favorites';

export interface LibraryStats {
  total: number;
  downloaded: number;
  missing: number;
  cutoff: number;
  unmonitored: number;
  favorites: number;
  artists: number;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  syncing: boolean;
  lidarrConfigured: boolean;
}

export interface LibraryAlbumsResponse {
  items: LibraryAlbum[];
  total: number;
}

export interface SyncResult {
  artists: number;
  albums: number;
  cutoffUnmet: number;
  durationMs: number;
}

export interface DripQueueItem {
  id: number;
  albumMbid: string;
  artistName: string;
  albumTitle: string;
  status: string;
  queuedAt: number;
  processedAt: number | null;
  error: string | null;
}

export interface DripStatus {
  paused: boolean;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
  batchSize: number;
  intervalSec: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  upcoming: DripQueueItem[];
  recent: DripQueueItem[];
  /** Newly added artists waiting for Lidarr's import before Spin Seek searches them. */
  pendingAdds: PendingAdd[];
}

export interface EnqueueResponse {
  queued: number;
  skippedCooldown: number;
  skippedDuplicate: number;
  skippedNotInLidarr: number;
}

export interface LidarrQueueItem {
  id: number;
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  status: string;
  trackedDownloadState: string | null;
  progress: number;
  size: number;
  sizeLeft: number;
  timeLeft: string | null;
  protocol: string | null;
  downloadClient: string | null;
  errorMessage: string | null;
}

export interface LidarrQueueResponse {
  configured: boolean;
  total: number;
  items: LidarrQueueItem[];
  error: string | null;
}

export type AiProvider = 'openai' | 'gemini';

export interface FeatureFlags {
  ai: boolean;
  recs: boolean;
  autocomplete: boolean;
  previews: boolean;
}

/** Secrets are never returned: only whether they are set. */
export interface SettingsResponse {
  lidarrUrl: string;
  hasLidarrApiKey: boolean;
  rootFolderPath: string;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  hasAiApiKey: boolean;
  aiModel: string;
  lastfmUsername: string;
  hasLastfmApiKey: boolean;
  dripBatchSize: number;
  dripIntervalSec: number;
  autoSelectRelease: boolean;
  preferredReleaseCountry: string;
  features: FeatureFlags;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  authSource: 'env' | 'settings' | 'none';
  authUsername: string;
  lidarrConfigured: boolean;
  aiConfigured: boolean;
  lastfmConfigured: boolean;
  version: string;
}

/**
 * Secret fields: undefined, "" or the "••••••••" mask keep the stored value; null clears it;
 * any other string replaces it. Changing a service URL requires re-entering its key.
 */
export interface SettingsUpdate {
  lidarrUrl?: string;
  lidarrApiKey?: string | null;
  rootFolderPath?: string;
  qualityProfileId?: number | null;
  metadataProfileId?: number | null;
  aiProvider?: AiProvider;
  aiBaseUrl?: string;
  aiApiKey?: string | null;
  aiModel?: string;
  lastfmApiKey?: string | null;
  lastfmUsername?: string;
  dripBatchSize?: number;
  dripIntervalSec?: number;
  autoSelectRelease?: boolean;
  preferredReleaseCountry?: string;
  features?: Partial<FeatureFlags>;
}

export const SECRET_MASK = '••••••••';

export type RecsMode = 'foryou' | 'similar' | 'scrobbles';
export type LastfmPeriod = '7day' | '1month' | '6month' | 'overall';

export interface RecsRequest {
  mode: RecsMode;
  /** Similar to Artist: the artist name. */
  artist?: string;
  /** My Last.fm Scrobbles: listening period. */
  period?: LastfmPeriod;
  /** For You: seeds already used (Shuffle Seeds picks different ones). */
  excludeSeeds?: string[];
  shuffle?: boolean;
}

export type RecsEvent =
  | { type: 'status'; message: string }
  | { type: 'seeds'; seeds: string[] }
  | { type: 'album'; album: AlbumResult }
  | { type: 'error'; error: string }
  | { type: 'done'; count: number };

export interface SimilarArtist {
  name: string;
  mbid: string | null;
  /** 0–100 */
  match: number;
  imageUrl: string | null;
}

export interface SuggestArtist {
  name: string;
  imageUrl: string | null;
  fans: number | null;
}

export interface SuggestAlbum {
  title: string;
  artist: string;
  coverUrl: string | null;
  recordType: string | null;
}

export interface SuggestResponse {
  artists: SuggestArtist[];
  albums: SuggestAlbum[];
}

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  username: string | null;
  source: 'env' | 'settings' | 'none';
  /** No login exists yet: the first visitor must create one before anything else works. */
  setupRequired: boolean;
}

export interface DeezerInfo {
  coverUrl: string | null;
  popularity: number | null;
  deezerAlbumId: number | null;
  link: string | null;
}

export interface PreviewTrack {
  previewUrl: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  coverUrl: string | null;
}

export interface RatingUpdate {
  rating: number | null;
  artistName: string;
  albumTitle: string;
  year: number | null;
  communityRating: number | null;
}
