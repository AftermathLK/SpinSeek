import { Loader2, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../lib/api';

const MIN_LENGTH = 8;

/** First start: nothing works until an account exists, so the app is never left open on the network. */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const valid = username.trim().length > 0 && password.length >= MIN_LENGTH && password === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/setup', { username: username.trim(), password });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.15),_transparent_60%)] px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="h-12 w-12" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Welcome to Spin Seek</h1>
            <p className="mt-1 text-sm text-zinc-400">Create the login that protects this server. Everything stays locked until you do.</p>
          </div>
        </div>
        <label className="label" htmlFor="setup-username">
          Username
        </label>
        <input
          id="setup-username"
          className="input mb-3"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label className="label" htmlFor="setup-password">
          Password
        </label>
        <input
          id="setup-password"
          type="password"
          className="input mb-1"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className={`mb-3 text-[11px] ${tooShort ? 'text-amber-300' : 'text-zinc-500'}`}>At least {MIN_LENGTH} characters.</p>
        <label className="label" htmlFor="setup-confirm">
          Confirm password
        </label>
        <input
          id="setup-confirm"
          type="password"
          className="input mb-1"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <p className={`mb-4 text-[11px] ${mismatch ? 'text-amber-300' : 'text-transparent'}`}>Passwords don't match.</p>
        {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <button type="submit" className="btn-primary w-full py-2" disabled={busy || !valid}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Create login
        </button>
        <p className="mt-4 text-center text-[11px] text-zinc-500">
          You can change it later in Settings → Security. Sessions stay signed in for 30 days.
        </p>
      </form>
    </div>
  );
}
