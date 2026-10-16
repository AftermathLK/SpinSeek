import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import type { AuthStatus, LidarrProfiles, SettingsResponse } from '../../shared/types';

export type SettingsSection = 'lidarr' | 'ai' | 'lastfm' | 'drip' | 'features' | 'security';

export interface ArtistRef {
  mbid: string;
  name: string;
}

interface AppApi {
  /** Artist page currently open (shown in the Discover tab), or null. */
  artist: ArtistRef | null;
  openArtist: (mbid: string, name: string) => void;
  closeArtist: () => void;
  auth: AuthStatus;
  settings: SettingsResponse | null;
  setSettings: (s: SettingsResponse) => void;
  reloadSettings: () => Promise<void>;
  profiles: LidarrProfiles | null;
  profilesError: string | null;
  reloadProfiles: (force?: boolean) => Promise<void>;
  settingsSection: SettingsSection | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  bottomInset: number;
  setBottomInset: (px: number) => void;
  activityVersion: number;
  bumpActivity: () => void;
  libraryVersion: number;
  bumpLibrary: () => void;
  logout: () => Promise<void>;
  refreshAuth: () => void;
}

const AppContext = createContext<AppApi | null>(null);

export function AppProvider({
  auth,
  onAuthChange,
  children,
}: {
  auth: AuthStatus;
  onAuthChange: () => void;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [profiles, setProfiles] = useState<LidarrProfiles | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [bottomInset, setBottomInset] = useState(0);
  const [activityVersion, setActivityVersion] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [artist, setArtist] = useState<ArtistRef | null>(null);

  // Artist pages are history entries, so the browser Back button returns to the results.
  // A reload or shared link (#artist/<mbid>) reopens the same artist page.
  useEffect(() => {
    const deepLink = window.location.hash.match(/^#artist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (deepLink) {
      const ref = { mbid: deepLink[1], name: '' };
      window.history.replaceState({ spinseekArtist: ref, pushed: false }, '', window.location.hash);
      setArtist(ref);
    } else if (window.location.hash.startsWith('#artist/')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { spinseekArtist?: ArtistRef } | null;
      setArtist(state?.spinseekArtist ?? null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openArtist = useCallback((mbid: string, name: string) => {
    const ref = { mbid, name };
    window.history.pushState({ spinseekArtist: ref, pushed: true }, '', `#artist/${mbid}`);
    setArtist(ref);
  }, []);

  const closeArtist = useCallback(() => {
    const state = window.history.state as { spinseekArtist?: ArtistRef; pushed?: boolean } | null;
    if (state?.spinseekArtist && state.pushed) {
      window.history.back();
    } else {
      // Opened from a reload/deep link: there is no in-app entry to go back to.
      window.history.replaceState(null, '', window.location.pathname);
      setArtist(null);
    }
  }, []);

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await api.get<SettingsResponse>('/api/settings'));
    } catch {
      // surfaced by the views that need settings
    }
  }, []);

  const reloadProfiles = useCallback(async (force = false) => {
    try {
      setProfiles(await api.get<LidarrProfiles>(`/api/lidarr/profiles${force ? '?refresh=1' : ''}`));
      setProfilesError(null);
    } catch (err) {
      setProfiles(null);
      setProfilesError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  useEffect(() => {
    if (settings?.lidarrConfigured) void reloadProfiles();
    else setProfiles(null);
  }, [settings?.lidarrConfigured, settings?.lidarrUrl, reloadProfiles]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      onAuthChange();
    }
  }, [onAuthChange]);

  const value = useMemo<AppApi>(
    () => ({
      artist,
      openArtist,
      closeArtist,
      auth,
      settings,
      setSettings,
      reloadSettings,
      profiles,
      profilesError,
      reloadProfiles,
      settingsSection,
      openSettings: (section: SettingsSection = 'lidarr') => setSettingsSection(section),
      closeSettings: () => setSettingsSection(null),
      bottomInset,
      setBottomInset,
      activityVersion,
      bumpActivity: () => setActivityVersion((v) => v + 1),
      libraryVersion,
      bumpLibrary: () => setLibraryVersion((v) => v + 1),
      logout,
      refreshAuth: onAuthChange,
    }),
    [
      artist,
      openArtist,
      closeArtist,
      auth,
      settings,
      reloadSettings,
      profiles,
      profilesError,
      reloadProfiles,
      settingsSection,
      bottomInset,
      activityVersion,
      libraryVersion,
      logout,
      onAuthChange,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
