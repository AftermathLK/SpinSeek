import { Loader2, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../lib/api';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username, password });
      onLoggedIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.15),_transparent_60%)] px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 shadow-2xl shadow-black/50">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="h-12 w-12" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Spin Seek</h1>
            <p className="text-sm text-zinc-400">Sign in to continue</p>
          </div>
        </div>
        <label className="label" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          className="input mb-3"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="input mb-4"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <button type="submit" className="btn-primary w-full py-2" disabled={busy || !username || !password}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Sign in
        </button>
        <p className="mt-4 text-center text-[11px] text-zinc-500">Sessions stay signed in for 30 days.</p>
      </form>
    </div>
  );
}
