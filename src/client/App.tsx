import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header, type TabId } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { MiniPlayer } from './components/MiniPlayer';
import { SettingsModal } from './components/SettingsModal';
import { SetupScreen } from './components/SetupScreen';
import { AppProvider, useApp } from './context/AppContext';
import { PlayerProvider } from './context/PlayerContext';
import { ToastProvider } from './context/ToastContext';
import { api, onUnauthorized } from './lib/api';
import { storageGetEnum, storageSet } from './lib/format';
import { DiscoverTab } from './tabs/DiscoverTab';
import { LibraryTab } from './tabs/LibraryTab';
import type { AuthStatus } from '../shared/types';

function Shell() {
  const { bottomInset, artist, closeArtist } = useApp();
  const [tab, setTab] = useState<TabId>(() => storageGetEnum<TabId>('tab', ['discover', 'library'], 'discover'));
  const discoverInput = useRef<HTMLTextAreaElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  const changeTab = useCallback(
    (t: TabId) => {
      setTab(t);
      storageSet('tab', t);
      // Leaving Discover via the tab bar closes an open artist page.
      if (t !== 'discover' && artist) closeArtist();
    },
    [artist, closeArtist],
  );

  // Artist pages live in the Discover tab (opened from search results or the Library).
  useEffect(() => {
    if (artist) setTab('discover');
  }, [artist]);

  // Cmd/Ctrl+K focuses the active tab's search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = tab === 'discover' ? discoverInput.current : libraryInput.current;
        el?.focus();
        el?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.08),_transparent_50%)]">
      <Header tab={tab} onTabChange={changeTab} />
      <main className="mx-auto max-w-7xl px-4 py-5" style={{ paddingBottom: bottomInset + 96 }}>
        <div className={tab === 'discover' ? '' : 'hidden'}>
          <ErrorBoundary label="Discover">
            <DiscoverTab active={tab === 'discover'} inputRef={discoverInput} />
          </ErrorBoundary>
        </div>
        <div className={tab === 'library' ? '' : 'hidden'}>
          <ErrorBoundary label="Library">
            <LibraryTab active={tab === 'library'} inputRef={libraryInput} />
          </ErrorBoundary>
        </div>
      </main>
      <ErrorBoundary silent>
        <MiniPlayer />
      </ErrorBoundary>
      <ErrorBoundary label="Settings">
        <SettingsModal />
      </ErrorBoundary>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAuth = useCallback(async () => {
    try {
      setAuth(await api.get<AuthStatus>('/api/auth/status'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshAuth = useCallback(() => {
    void loadAuth();
  }, [loadAuth]);

  useEffect(() => {
    void loadAuth();
    // Session expired or credentials changed elsewhere: re-read status (→ Login or Setup screen).
    onUnauthorized(() => {
      void loadAuth();
    });
  }, [loadAuth]);

  if (error && !auth) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-red-300">{error}</p>
        <button className="btn-secondary" onClick={() => void loadAuth()}>
          Retry
        </button>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <ToastProvider>
      {auth.setupRequired ? (
        <SetupScreen onDone={() => void loadAuth()} />
      ) : auth.authRequired && !auth.authenticated ? (
        <LoginScreen onLoggedIn={() => void loadAuth()} />
      ) : (
        <AppProvider auth={auth} onAuthChange={refreshAuth}>
          <PlayerProvider>
            <Shell />
          </PlayerProvider>
        </AppProvider>
      )}
    </ToastProvider>
  );
}
