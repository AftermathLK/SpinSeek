import {
  AudioLines,
  Bot,
  CheckCircle2,
  Copy,
  Disc3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  Radio,
  RefreshCw,
  Save,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Webhook,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp, type SettingsSection } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { api, errorText } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatBytes, timeAgo } from '../lib/format';
import { Modal } from './Modal';
import { SECRET_MASK } from '../../shared/types';
import type { AiProvider, FeatureFlags, LibraryStats, SettingsResponse, SettingsUpdate } from '../../shared/types';

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Server }[] = [
  { id: 'lidarr', label: 'Lidarr', icon: Server },
  { id: 'ai', label: 'AI', icon: Bot },
  { id: 'lastfm', label: 'Last.fm', icon: Radio },
  { id: 'drip', label: 'Drip Queue', icon: Timer },
  { id: 'features', label: 'Features', icon: SlidersHorizontal },
  { id: 'security', label: 'Security', icon: Shield },
];

interface FormState {
  lidarrUrl: string;
  lidarrApiKey: string;
  rootFolderPath: string;
  qualityProfileId: string;
  metadataProfileId: string;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  lastfmApiKey: string;
  lastfmUsername: string;
  dripBatchSize: string;
  dripIntervalSec: string;
  autoSelectRelease: boolean;
  preferredReleaseCountry: string;
}

const EDITION_COUNTRIES: { code: string; label: string }[] = [
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'IE', label: 'Ireland' },
  { code: 'AU', label: 'Australia' },
  { code: 'NZ', label: 'New Zealand' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'SE', label: 'Sweden' },
  { code: 'JP', label: 'Japan' },
  { code: 'XW', label: 'Worldwide (digital)' },
  { code: 'XE', label: 'Europe' },
  { code: 'ANY', label: 'Any country' },
];

const FEATURE_TOGGLES: { key: keyof FeatureFlags; label: string; description: string; icon: typeof Sparkles }[] = [
  { key: 'ai', label: 'Enable AI Discovery tab', description: 'Shows the ✨ AI Discovery mode. When off, the tab is hidden and AI routes are disabled.', icon: Sparkles },
  {
    key: 'recs',
    label: 'Enable Recommendations & Last.fm',
    description: 'Shows the 📻 Recommendations mode and Similar Artists on artist pages (needs a Last.fm API key).',
    icon: Radio,
  },
  {
    key: 'autocomplete',
    label: 'Enable live search autocomplete',
    description: 'Suggests artists and albums while you type a single search. Off = only Enter / Search.',
    icon: Search,
  },
  { key: 'previews', label: 'Enable 30s audio previews', description: 'Shows the preview play buttons on album rows and cards.', icon: AudioLines },
];

function formFrom(s: SettingsResponse): FormState {
  return {
    lidarrUrl: s.lidarrUrl,
    lidarrApiKey: '',
    rootFolderPath: s.rootFolderPath,
    qualityProfileId: s.qualityProfileId ? String(s.qualityProfileId) : '',
    metadataProfileId: s.metadataProfileId ? String(s.metadataProfileId) : '',
    aiProvider: s.aiProvider,
    aiBaseUrl: s.aiBaseUrl,
    aiApiKey: '',
    aiModel: s.aiModel,
    lastfmApiKey: '',
    lastfmUsername: s.lastfmUsername,
    dripBatchSize: String(s.dripBatchSize),
    dripIntervalSec: String(s.dripIntervalSec),
    autoSelectRelease: s.autoSelectRelease,
    preferredReleaseCountry: s.preferredReleaseCountry,
  };
}

function sameUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
      {hint && <div className="mt-1 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

/** Stored keys are never sent to the browser: the field only says whether one is saved. */
function SecretInput({
  value,
  onChange,
  isSet,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  isSet: boolean;
  placeholder: string;
  invalid?: boolean;
}) {
  return (
    <input
      className={`input font-mono ${invalid ? 'border-amber-500/70 focus:border-amber-400' : ''}`}
      type="password"
      autoComplete="off"
      value={value}
      placeholder={isSet ? `${SECRET_MASK} saved, leave blank to keep` : placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TestResult({ state }: { state: { ok: boolean; message: string } | null }) {
  if (!state) return null;
  return (
    <p className={`flex items-start gap-1.5 text-xs ${state.ok ? 'text-emerald-300' : 'text-red-300'}`}>
      {state.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span>{state.message}</span>
    </p>
  );
}

/**
 * The external API key / webhook secret are only shown after re-entering the login password
 * (a stolen session alone can't read them). Values are kept in memory only while the modal is open.
 */
function RevealSecret({
  which,
  format,
  onRegenerated,
}: {
  which: 'api_key' | 'webhook_secret';
  format: (value: string) => string;
  onRegenerated: (s: SettingsResponse) => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reveal = async (regenerate: boolean) => {
    if (regenerate && !window.confirm('Generate a new value? Anything using the current one stops working.')) return;
    setBusy(true);
    try {
      if (regenerate) {
        const res = await api.post<{ value: string; settings: SettingsResponse }>('/api/settings/regenerate', { key: which, password });
        setValue(res.value);
        onRegenerated(res.settings);
        toast.success('New value generated');
      } else {
        setValue((await api.post<{ value: string }>('/api/settings/reveal', { which, password })).value);
      }
      setPassword('');
    } catch (err) {
      toast.error(regenerate ? 'Could not regenerate' : 'Could not reveal', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (value !== null) {
    const shown = format(value);
    return (
      <div className="flex gap-2">
        <input className="input font-mono text-xs" readOnly value={shown} onFocus={(e) => e.target.select()} />
        <button
          className="btn-secondary"
          aria-label="Copy"
          onClick={async () => {
            if (await copyText(shown)) toast.success('Copied to clipboard');
            else toast.error('Copy failed: select the text and copy manually');
          }}
        >
          <Copy className="h-4 w-4" />
        </button>
        <button className="btn-secondary" aria-label="Hide" onClick={() => setValue(null)}>
          <EyeOff className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <input
        className="input max-w-[16rem]"
        type="password"
        autoComplete="current-password"
        placeholder="Your login password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && password && void reveal(false)}
      />
      <button className="btn-secondary" disabled={busy || !password} onClick={() => void reveal(false)}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Reveal
      </button>
      <button className="btn-ghost" disabled={busy || !password} onClick={() => void reveal(true)}>
        <RefreshCw className="h-4 w-4" /> Regenerate
      </button>
    </div>
  );
}

export function SettingsModal() {
  const {
    settingsSection,
    closeSettings,
    openSettings,
    settings,
    setSettings,
    profiles,
    profilesError,
    reloadProfiles,
    bumpLibrary,
    refreshAuth,
  } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [lidarrTest, setLidarrTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [aiTest, setAiTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [lastfmTest, setLastfmTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState<'lidarr' | 'ai' | 'lastfm' | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [authUser, setAuthUser] = useState('');
  const [authCurrent, setAuthCurrent] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authConfirm, setAuthConfirm] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [featureBusy, setFeatureBusy] = useState(false);

  const open = settingsSection !== null;

  useEffect(() => {
    if (open && settings) {
      setForm(formFrom(settings));
      setLidarrTest(null);
      setAiTest(null);
      setLastfmTest(null);
      setAuthUser(settings.authUsername);
      setAuthCurrent('');
      setAuthPass('');
      setAuthConfirm('');
      api
        .get<LibraryStats>('/api/library/stats')
        .then(setStats)
        .catch(() => setStats(null));
    }
    // Reset the form only when the modal opens (or settings first arrive), not on every settings refresh.
  }, [open, settings === null]);

  if (!open || !settings || !form) {
    return open ? (
      <Modal open onClose={closeSettings} title="Settings">
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        </div>
      </Modal>
    ) : null;
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  // A stored key is never sent to a new URL: changing the URL requires typing the key again.
  const lidarrNeedsKey = settings.hasLidarrApiKey && !sameUrl(form.lidarrUrl, settings.lidarrUrl) && !form.lidarrApiKey.trim();
  const aiNeedsKey = settings.hasAiApiKey && !sameUrl(form.aiBaseUrl, settings.aiBaseUrl) && !form.aiApiKey.trim();

  const buildUpdate = (): SettingsUpdate => ({
    lidarrUrl: form.lidarrUrl.trim(),
    ...(form.lidarrApiKey.trim() ? { lidarrApiKey: form.lidarrApiKey.trim() } : {}),
    rootFolderPath: form.rootFolderPath,
    qualityProfileId: form.qualityProfileId ? Number(form.qualityProfileId) : null,
    metadataProfileId: form.metadataProfileId ? Number(form.metadataProfileId) : null,
    aiProvider: form.aiProvider,
    aiBaseUrl: form.aiBaseUrl.trim(),
    ...(form.aiApiKey.trim() ? { aiApiKey: form.aiApiKey.trim() } : {}),
    aiModel: form.aiModel.trim(),
    ...(form.lastfmApiKey.trim() ? { lastfmApiKey: form.lastfmApiKey.trim() } : {}),
    lastfmUsername: form.lastfmUsername.trim(),
    dripBatchSize: Number(form.dripBatchSize),
    dripIntervalSec: Number(form.dripIntervalSec),
    autoSelectRelease: form.autoSelectRelease,
    preferredReleaseCountry: form.preferredReleaseCountry,
  });

  const save = async (silent = false): Promise<SettingsResponse | null> => {
    if (lidarrNeedsKey || aiNeedsKey) {
      toast.error('Re-enter the API key', `You changed the ${lidarrNeedsKey ? 'Lidarr URL' : 'AI base URL'}; type its API key again to save.`);
      openSettings(lidarrNeedsKey ? 'lidarr' : 'ai');
      return null;
    }
    setSaving(true);
    try {
      const updated = await api.put<SettingsResponse>('/api/settings', buildUpdate());
      setSettings(updated);
      setForm((f) => (f ? { ...f, lidarrApiKey: '', aiApiKey: '', lastfmApiKey: '' } : f));
      if (updated.lidarrConfigured) void reloadProfiles(true);
      if (!silent) toast.success('Settings saved');
      return updated;
    } catch (err) {
      toast.error('Could not save settings', errorText(err));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const clearSecret = async (field: 'aiApiKey' | 'lastfmApiKey', label: string) => {
    try {
      setSettings(await api.put<SettingsResponse>('/api/settings', { [field]: null }));
      toast.info(`${label} removed`);
    } catch (err) {
      toast.error('Could not remove key', errorText(err));
    }
  };

  const testLidarr = async () => {
    setTesting('lidarr');
    setLidarrTest(null);
    try {
      const res = await api.post<{ version: string; appName: string; instanceName: string | null }>('/api/lidarr/test', {
        url: form.lidarrUrl,
        apiKey: form.lidarrApiKey.trim() || undefined,
      });
      setLidarrTest({ ok: true, message: `Connected to ${res.instanceName || res.appName} v${res.version}` });
    } catch (err) {
      setLidarrTest({ ok: false, message: errorText(err) });
    } finally {
      setTesting(null);
    }
  };

  const testAi = async () => {
    setTesting('ai');
    setAiTest(null);
    const saved = await save(true);
    if (!saved) {
      setTesting(null);
      return;
    }
    try {
      const res = await api.post<{ model: string; sample: string }>('/api/ai/test');
      setAiTest({ ok: true, message: `${res.model} responded: ${res.sample}` });
    } catch (err) {
      setAiTest({ ok: false, message: errorText(err) });
    } finally {
      setTesting(null);
    }
  };

  const testLastfm = async () => {
    setTesting('lastfm');
    setLastfmTest(null);
    try {
      const res = await api.post<{ user: string | null; scrobbles: number | null }>('/api/lastfm/test', {
        apiKey: form.lastfmApiKey.trim() || undefined,
        username: form.lastfmUsername.trim(),
      });
      setLastfmTest({
        ok: true,
        message: res.user ? `Key works. ${res.user} has ${res.scrobbles?.toLocaleString('en-US') ?? 0} scrobbles.` : 'Key works.',
      });
    } catch (err) {
      setLastfmTest({ ok: false, message: errorText(err) });
    } finally {
      setTesting(null);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await api.post<{ result: { artists: number; albums: number }; stats: LibraryStats }>('/api/library/sync');
      setStats(res.stats);
      bumpLibrary();
      toast.success('Library synced', `${res.result.artists} artists · ${res.result.albums} albums`);
    } catch (err) {
      toast.error('Sync failed', errorText(err));
    } finally {
      setSyncing(false);
    }
  };

  const toggleFeature = async (key: keyof FeatureFlags, value: boolean) => {
    setFeatureBusy(true);
    try {
      setSettings(await api.put<SettingsResponse>('/api/settings', { features: { [key]: value } }));
    } catch (err) {
      toast.error('Could not update feature', errorText(err));
    } finally {
      setFeatureBusy(false);
    }
  };

  const saveCredentials = async () => {
    setAuthBusy(true);
    try {
      await api.put('/api/auth/credentials', { currentPassword: authCurrent, username: authUser.trim(), password: authPass });
      setSettings(await api.get<SettingsResponse>('/api/settings'));
      setAuthCurrent('');
      setAuthPass('');
      setAuthConfirm('');
      toast.success('Login updated', 'Other browsers were signed out; this one stays signed in.');
      refreshAuth();
    } catch (err) {
      toast.error('Could not update login', errorText(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const webhookUrl = (secret: string) => `${window.location.origin}/api/webhook/lidarr?secret=${secret}`;

  return (
    <Modal
      open
      onClose={closeSettings}
      title="Settings"
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-zinc-500">Spin Seek v{settings.version}</span>
          <button className="btn-ghost" onClick={closeSettings}>
            Close
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-40 sm:flex-col">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => openSettings(id)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                settingsSection === id ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {settingsSection === 'lidarr' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Lidarr URL" hint="e.g. http://192.168.1.20:8686">
                  <input
                    className="input"
                    value={form.lidarrUrl}
                    placeholder="http://lidarr:8686"
                    onChange={(e) => set('lidarrUrl', e.target.value)}
                  />
                </Field>
                <Field
                  label="API Key"
                  hint={
                    lidarrNeedsKey ? (
                      <span className="text-amber-300">The URL changed: re-enter the API key to save or test it.</span>
                    ) : (
                      'Lidarr → Settings → General → Security'
                    )
                  }
                >
                  <SecretInput
                    value={form.lidarrApiKey}
                    onChange={(v) => set('lidarrApiKey', v)}
                    isSet={settings.hasLidarrApiKey}
                    placeholder="Paste API key"
                    invalid={lidarrNeedsKey}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn-secondary" onClick={testLidarr} disabled={testing !== null || lidarrNeedsKey}>
                  {testing === 'lidarr' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                  Test Connection
                </button>
                <button className="btn-secondary" onClick={() => void save()} disabled={saving}>
                  <Save className="h-4 w-4" /> Save &amp; Load Profiles
                </button>
                <TestResult state={lidarrTest} />
              </div>

              <div className="card space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Defaults for “Send to Lidarr”</h3>
                  {settings.lidarrConfigured && (
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void reloadProfiles(true)}>
                      <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </button>
                  )}
                </div>
                {!settings.lidarrConfigured && <p className="text-xs text-zinc-500">Save a working Lidarr connection to load profiles.</p>}
                {profilesError && <p className="text-xs text-red-300">{profilesError}</p>}
                {profiles && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Root Folder">
                      <select className="select" value={form.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)}>
                        <option value="">Choose…</option>
                        {profiles.rootFolders.map((r) => (
                          <option key={r.id} value={r.path}>
                            {r.path}
                            {r.freeSpace ? ` (${formatBytes(r.freeSpace)} free)` : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Quality Profile">
                      <select className="select" value={form.qualityProfileId} onChange={(e) => set('qualityProfileId', e.target.value)}>
                        <option value="">Choose…</option>
                        {profiles.qualityProfiles.map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Metadata Profile">
                      <select className="select" value={form.metadataProfileId} onChange={(e) => set('metadataProfileId', e.target.value)}>
                        <option value="">Choose…</option>
                        {profiles.metadataProfiles.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
              </div>

              <div className="card space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Library Sync</h3>
                    <p className="text-xs text-zinc-500">
                      Automatic every 15 minutes · last sync {timeAgo(stats?.lastSyncAt)}
                      {stats && ` · ${stats.artists} artists, ${stats.total} albums`}
                    </p>
                    {stats?.lastSyncError && <p className="mt-1 text-xs text-red-300">{stats.lastSyncError}</p>}
                  </div>
                  <button className="btn-secondary" onClick={syncNow} disabled={syncing || !settings.lidarrConfigured}>
                    <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /> Sync now
                  </button>
                </div>
              </div>

              <div className="card space-y-3 p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Disc3 className="h-4 w-4 text-violet-400" /> Editions
                </h3>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="checkbox mt-0.5"
                    checked={form.autoSelectRelease}
                    onChange={(e) => set('autoSelectRelease', e.target.checked)}
                  />
                  <span>
                    Automatically pick the standard edition in Lidarr
                    <span className="block text-xs text-zinc-500">
                      Prefers the official, single-disc pressing with the usual track count from the country below, and skips
                      deluxe, exclusive (Best Buy, Target…), signed, clean and bonus-track variants. You can still choose a
                      specific edition per album in the Editions drawer.
                    </span>
                  </span>
                </label>
                <Field label="Preferred edition country">
                  <select
                    className="select sm:w-64"
                    value={form.preferredReleaseCountry}
                    onChange={(e) => set('preferredReleaseCountry', e.target.value)}
                  >
                    {EDITION_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="card space-y-3 p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Webhook className="h-4 w-4 text-violet-400" /> Instant updates via Lidarr Webhook
                </h3>
                <p className="text-xs text-zinc-400">The URL contains a secret: confirm your password to show it.</p>
                <RevealSecret which="webhook_secret" format={webhookUrl} onRegenerated={setSettings} />
                <ol className="list-decimal space-y-0.5 pl-5 text-xs text-zinc-400">
                  <li>Lidarr → Settings → Connect → + → Webhook</li>
                  <li>Paste the URL above, method POST</li>
                  <li>Enable On Grab, On Release Import, On Upgrade, On Artist Add/Delete, On Album Delete</li>
                </ol>
              </div>
            </>
          )}

          {settingsSection === 'ai' && (
            <>
              {!settings.features.ai && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  AI Discovery is turned off in Settings → Features.
                </p>
              )}
              <Field label="Provider">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['openai', 'OpenAI-compatible', 'OpenAI, Ollama, LM Studio, Open WebUI'],
                      ['gemini', 'Google Gemini', 'Gemini API key'],
                    ] as const
                  ).map(([id, label, sub]) => (
                    <button
                      key={id}
                      onClick={() => {
                        set('aiProvider', id);
                        if (id === 'gemini' && /api\.openai\.com/.test(form.aiBaseUrl)) {
                          set('aiBaseUrl', 'https://generativelanguage.googleapis.com/v1beta');
                        }
                        if (id === 'openai' && /generativelanguage/.test(form.aiBaseUrl)) set('aiBaseUrl', 'https://api.openai.com/v1');
                      }}
                      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                        form.aiProvider === id ? 'border-violet-500 bg-violet-500/10' : 'border-zinc-700 hover:border-zinc-600'
                      }`}
                    >
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-[11px] text-zinc-500">{sub}</p>
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="Base URL"
                hint={
                  form.aiProvider === 'openai'
                    ? 'OpenAI: https://api.openai.com/v1 · Ollama: http://host:11434/v1 · LM Studio: http://host:1234/v1 · Open WebUI: http://host:3000/api'
                    : 'Default: https://generativelanguage.googleapis.com/v1beta'
                }
              >
                <input className="input" value={form.aiBaseUrl} onChange={(e) => set('aiBaseUrl', e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="API Key"
                  hint={
                    aiNeedsKey ? (
                      <span className="text-amber-300">The base URL changed: re-enter the key (or clear it) to save.</span>
                    ) : form.aiProvider === 'openai' ? (
                      'Optional for local servers like Ollama'
                    ) : undefined
                  }
                >
                  <div className="flex gap-2">
                    <SecretInput
                      value={form.aiApiKey}
                      onChange={(v) => set('aiApiKey', v)}
                      isSet={settings.hasAiApiKey}
                      placeholder="sk-… / AIza…"
                      invalid={aiNeedsKey}
                    />
                    {settings.hasAiApiKey && (
                      <button className="btn-secondary" title="Remove saved key" onClick={() => void clearSecret('aiApiKey', 'AI API key')}>
                        Clear
                      </button>
                    )}
                  </div>
                </Field>
                <Field label="Model" hint="e.g. gpt-4o-mini, llama3.1:8b, qwen2.5:14b, gemini-2.5-flash">
                  <input className="input" value={form.aiModel} onChange={(e) => set('aiModel', e.target.value)} placeholder="Model name" />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn-secondary" onClick={testAi} disabled={testing !== null || !settings.features.ai}>
                  {testing === 'ai' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                  Save &amp; Test
                </button>
                <TestResult state={aiTest} />
              </div>
              <p className="text-xs text-zinc-500">
                AI Discovery automatically includes your 4★+ ratings as taste context and your Lidarr library as an exclusion list, so
                recommendations focus on music you don't own yet.
              </p>
            </>
          )}

          {settingsSection === 'lastfm' && (
            <>
              {!settings.features.recs && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Recommendations &amp; Last.fm are turned off in Settings → Features.
                </p>
              )}
              <p className="text-sm text-zinc-400">
                Powers 📻 Recommendations (For You, Similar to Artist, your scrobbles) and Similar Artists on artist pages. No AI
                required.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Last.fm API Key"
                  hint={
                    <>
                      Free:{' '}
                      <a className="text-violet-300 hover:underline" href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer noopener">
                        last.fm/api/account/create
                      </a>
                    </>
                  }
                >
                  <div className="flex gap-2">
                    <SecretInput
                      value={form.lastfmApiKey}
                      onChange={(v) => set('lastfmApiKey', v)}
                      isSet={settings.hasLastfmApiKey}
                      placeholder="32-character API key"
                    />
                    {settings.hasLastfmApiKey && (
                      <button className="btn-secondary" title="Remove saved key" onClick={() => void clearSecret('lastfmApiKey', 'Last.fm API key')}>
                        Clear
                      </button>
                    )}
                  </div>
                </Field>
                <Field label="Last.fm Username (optional)" hint="Enables “My Last.fm Scrobbles”">
                  <input
                    className="input"
                    value={form.lastfmUsername}
                    placeholder="username"
                    onChange={(e) => set('lastfmUsername', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn-secondary" onClick={testLastfm} disabled={testing !== null}>
                  {testing === 'lastfm' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
                  Test Last.fm
                </button>
                <button className="btn-secondary" onClick={() => void save()} disabled={saving}>
                  <Save className="h-4 w-4" /> Save
                </button>
                <TestResult state={lastfmTest} />
              </div>
            </>
          )}

          {settingsSection === 'drip' && (
            <>
              <p className="text-sm text-zinc-400">
                The drip queue sends Lidarr <code className="text-violet-300">AlbumSearch</code> commands in small batches so your
                indexers aren't hammered by hundreds of simultaneous searches.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Batch size" hint="Albums per search command (1–10)">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={10}
                    value={form.dripBatchSize}
                    onChange={(e) => set('dripBatchSize', e.target.value)}
                  />
                </Field>
                <Field label="Interval (seconds)" hint="Delay between batches (15–3600)">
                  <input
                    className="input"
                    type="number"
                    min={15}
                    max={3600}
                    value={form.dripIntervalSec}
                    onChange={(e) => set('dripIntervalSec', e.target.value)}
                  />
                </Field>
              </div>
              <p className="text-xs text-zinc-500">
                At these settings: ~{Math.round((3600 / Math.max(15, Number(form.dripIntervalSec) || 45)) * (Number(form.dripBatchSize) || 2))}{' '}
                albums per hour. Albums searched in the last 24 hours are skipped unless you tick “Ignore 24h Cooldown”.
              </p>
            </>
          )}

          {settingsSection === 'features' && (
            <>
              <p className="text-sm text-zinc-400">Turn off what you don't use. Changes apply instantly.</p>
              <div className="space-y-2">
                {FEATURE_TOGGLES.map(({ key, label, description, icon: Icon }) => (
                  <label key={key} className="card flex cursor-pointer items-start gap-3 p-3.5">
                    <input
                      type="checkbox"
                      className="checkbox mt-0.5"
                      checked={settings.features[key]}
                      disabled={featureBusy}
                      onChange={(e) => void toggleFeature(key, e.target.checked)}
                      aria-label={label}
                    />
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
                    <span>
                      <span className="block text-sm font-medium text-zinc-100">{label}</span>
                      <span className="block text-xs text-zinc-500">{description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {settingsSection === 'security' && (
            <>
              <div className="card space-y-3 p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Shield className="h-4 w-4 text-violet-400" /> Login
                </h3>
                {settings.authSource === 'env' && (
                  <p className="text-xs text-zinc-400">
                    Login is enforced by the <code className="text-violet-300">AUTH_USERNAME</code> /{' '}
                    <code className="text-violet-300">AUTH_PASSWORD</code> environment variables. Change them in your Docker
                    template to update credentials.
                  </p>
                )}
                {settings.authSource === 'settings' && (
                  <>
                    <p className="text-xs text-zinc-400">
                      Signed in as “{settings.authUsername}”. Login is always required; sessions last 30 days. Changing the
                      login signs out every other browser.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Username">
                        <input className="input" value={authUser} onChange={(e) => setAuthUser(e.target.value)} autoComplete="username" />
                      </Field>
                      <Field label="Current password">
                        <input
                          className="input"
                          type="password"
                          value={authCurrent}
                          onChange={(e) => setAuthCurrent(e.target.value)}
                          autoComplete="current-password"
                        />
                      </Field>
                      <Field label="New password" hint="At least 8 characters">
                        <input
                          className="input"
                          type="password"
                          value={authPass}
                          onChange={(e) => setAuthPass(e.target.value)}
                          autoComplete="new-password"
                        />
                      </Field>
                      <Field
                        label="Confirm new password"
                        hint={authConfirm && authConfirm !== authPass ? <span className="text-amber-300">Passwords don't match.</span> : undefined}
                      >
                        <input
                          className="input"
                          type="password"
                          value={authConfirm}
                          onChange={(e) => setAuthConfirm(e.target.value)}
                          autoComplete="new-password"
                        />
                      </Field>
                    </div>
                    <button
                      className="btn-primary"
                      onClick={() => void saveCredentials()}
                      disabled={authBusy || !authUser.trim() || !authCurrent || authPass.length < 8 || authPass !== authConfirm}
                    >
                      {authBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                      Update login
                    </button>
                  </>
                )}
              </div>

              <div className="card space-y-3 p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="h-4 w-4 text-violet-400" /> External API Key
                </h3>
                <RevealSecret which="api_key" format={(v) => v} onRegenerated={setSettings} />
                <p className="text-xs text-zinc-500">
                  Send as an <code className="text-violet-300">X-Api-Key</code> header to call any <code className="text-violet-300">/api</code>{' '}
                  endpoint, e.g.{' '}
                  <code className="break-all text-zinc-400">curl -H &quot;X-Api-Key: …&quot; {window.location.origin}/api/library/stats</code>
                </p>
              </div>

              <div className="card space-y-2 p-4 text-xs text-zinc-400">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  <Shield className="h-4 w-4 text-violet-400" /> How your keys are protected
                </h3>
                <p>
                  API keys are encrypted in the database (AES-256-GCM) and never sent back to the browser. A saved key is only ever
                  used with the URL it was saved for; changing a URL requires typing the key again.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
