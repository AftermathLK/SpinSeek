import { Compass, Library, LogOut, Settings } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ActivityPill } from './ActivityPill';

export type TabId = 'discover' | 'library';

interface Props {
  tab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: { id: TabId; label: string; short: string; icon: typeof Compass }[] = [
  { id: 'discover', label: 'Discover & Batch Search', short: 'Discover', icon: Compass },
  { id: 'library', label: 'My Lidarr Library', short: 'Library', icon: Library },
];

export function Header({ tab, onTabChange }: Props) {
  const { openSettings, auth, logout } = useApp();
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4">
        <div className="flex shrink-0 items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="hidden bg-gradient-to-r from-violet-300 to-cyan-300 bg-clip-text text-lg font-bold tracking-tight text-transparent md:inline">
            Spin Seek
          </span>
        </div>
        <nav className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
          {TABS.map(({ id, label, short, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
                tab === id ? 'bg-zinc-800 text-zinc-50 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              aria-current={tab === id ? 'page' : undefined}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden lg:inline">{label}</span>
              <span className="hidden sm:inline lg:hidden">{short}</span>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ActivityPill />
          <button className="btn-ghost p-2" onClick={() => openSettings()} aria-label="Settings" title="Settings">
            <Settings className="h-4 w-4" />
          </button>
          {auth.authRequired && (
            <button className="btn-ghost p-2" onClick={() => void logout()} aria-label="Log out" title="Log out">
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
