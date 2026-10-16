import { Router, type Request, type Response } from 'express';
import { aiConfigured, testAi } from '../ai.js';
import { authSource, requireCurrentPassword } from '../auth.js';
import { APP_VERSION } from '../config.js';
import { getOptionalIntSetting, getSetting, randomToken, setSetting } from '../db.js';
import { restartDripWorker } from '../drip.js';
import { RELEASE_COUNTRIES } from '../editions.js';
import { features, requireFeature } from '../features.js';
import { ApiError, ah } from '../http.js';
import { lastfmConfigured, testLastfm } from '../lastfm.js';
import { getConnection, getProfiles, getSystemStatus, invalidateProfileCache, lidarrConfigured } from '../lidarr.js';
import { getSecret, hasSecret, setSecret, type SecretKey } from '../secrets.js';
import { SECRET_MASK, type AiProvider, type FeatureFlags, type SettingsResponse, type SettingsUpdate } from '../../shared/types.js';

export const settingsRouter = Router();

/** Never includes a secret value: only whether each one is set. */
function buildSettings(): SettingsResponse {
  return {
    lidarrUrl: getSetting('lidarr_url'),
    hasLidarrApiKey: hasSecret('lidarr_api_key'),
    rootFolderPath: getSetting('root_folder_path'),
    qualityProfileId: getOptionalIntSetting('quality_profile_id'),
    metadataProfileId: getOptionalIntSetting('metadata_profile_id'),
    aiProvider: (getSetting('ai_provider') === 'gemini' ? 'gemini' : 'openai') as AiProvider,
    aiBaseUrl: getSetting('ai_base_url'),
    hasAiApiKey: hasSecret('ai_api_key'),
    aiModel: getSetting('ai_model'),
    lastfmUsername: getSetting('lastfm_username'),
    hasLastfmApiKey: hasSecret('lastfm_api_key'),
    dripBatchSize: Number(getSetting('drip_batch_size')) || 2,
    dripIntervalSec: Number(getSetting('drip_interval_sec')) || 45,
    autoSelectRelease: getSetting('auto_select_release') !== '0',
    preferredReleaseCountry: getSetting('preferred_release_country') || 'US',
    features: features(),
    hasApiKey: hasSecret('api_key'),
    hasWebhookSecret: hasSecret('webhook_secret'),
    authSource: authSource(),
    authUsername: authSource() === 'settings' ? getSetting('auth_username') : '',
    lidarrConfigured: lidarrConfigured(),
    aiConfigured: aiConfigured(),
    lastfmConfigured: lastfmConfigured(),
    version: APP_VERSION,
  };
}

function validUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Comparable form of a service URL (scheme + host + path, no trailing slash). */
function normalizeUrl(value: string): string {
  try {
    const u = new URL(value.trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

type SecretAction = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; value: string };

/** undefined, "" or the mask keep the stored key; null clears it; anything else replaces it. */
function secretAction(value: unknown, label: string): SecretAction {
  if (value === undefined) return { kind: 'keep' };
  if (value === null) return { kind: 'clear' };
  if (typeof value !== 'string') throw new ApiError(400, `${label} must be a string.`);
  const v = value.trim();
  if (!v || v === SECRET_MASK || /^[•*●]+$/.test(v)) return { kind: 'keep' };
  if (v.length > 512) throw new ApiError(400, `${label} is too long.`);
  return { kind: 'set', value: v };
}

function applySecret(name: SecretKey, action: SecretAction): boolean {
  if (action.kind === 'clear') setSecret(name, '');
  else if (action.kind === 'set') setSecret(name, action.value);
  return action.kind !== 'keep';
}

function intInRange(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  return Math.round(n);
}

settingsRouter.get('/settings', (_req, res) => {
  res.json(buildSettings());
});

async function updateSettings(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as SettingsUpdate;
  const lidarrKey = secretAction(body.lidarrApiKey, 'Lidarr API key');
  const aiKey = secretAction(body.aiApiKey, 'AI API key');
  const lastfmKey = secretAction(body.lastfmApiKey, 'Last.fm API key');

  // SSRF / credential-exfiltration guard: a stored key is never sent to a new URL unless it is re-entered.
  let lidarrUrl: string | null = null;
  if (body.lidarrUrl !== undefined) {
    lidarrUrl = String(body.lidarrUrl).trim().replace(/\/+$/, '');
    if (lidarrUrl && !validUrl(lidarrUrl)) throw new ApiError(400, 'Lidarr URL must start with http:// or https://');
    const changed = normalizeUrl(lidarrUrl) !== normalizeUrl(getSetting('lidarr_url'));
    if (changed && hasSecret('lidarr_api_key') && lidarrKey.kind === 'keep') {
      throw new ApiError(400, 'Re-enter the Lidarr API key when changing the Lidarr URL.');
    }
  }
  let aiBaseUrl: string | null = null;
  if (body.aiBaseUrl !== undefined) {
    aiBaseUrl = String(body.aiBaseUrl).trim().replace(/\/+$/, '');
    if (aiBaseUrl && !validUrl(aiBaseUrl)) throw new ApiError(400, 'AI base URL must start with http:// or https://');
    const changed = normalizeUrl(aiBaseUrl) !== normalizeUrl(getSetting('ai_base_url'));
    if (changed && hasSecret('ai_api_key') && aiKey.kind === 'keep') {
      throw new ApiError(400, 'Re-enter the AI API key (or clear it) when changing the AI base URL.');
    }
  }

  let lidarrChanged = false;
  let dripChanged = false;
  if (lidarrUrl !== null) {
    setSetting('lidarr_url', lidarrUrl);
    lidarrChanged = true;
  }
  if (applySecret('lidarr_api_key', lidarrKey)) lidarrChanged = true;
  if (body.rootFolderPath !== undefined) setSetting('root_folder_path', String(body.rootFolderPath ?? ''));
  if (body.qualityProfileId !== undefined) setSetting('quality_profile_id', body.qualityProfileId ? String(body.qualityProfileId) : '');
  if (body.metadataProfileId !== undefined) setSetting('metadata_profile_id', body.metadataProfileId ? String(body.metadataProfileId) : '');

  if (body.aiProvider !== undefined) {
    if (body.aiProvider !== 'openai' && body.aiProvider !== 'gemini') throw new ApiError(400, 'Unknown AI provider.');
    setSetting('ai_provider', body.aiProvider);
  }
  if (aiBaseUrl !== null) setSetting('ai_base_url', aiBaseUrl);
  applySecret('ai_api_key', aiKey);
  if (body.aiModel !== undefined) setSetting('ai_model', String(body.aiModel).trim().slice(0, 200));

  applySecret('lastfm_api_key', lastfmKey);
  if (body.lastfmUsername !== undefined) {
    const user = String(body.lastfmUsername).trim();
    if (user && !/^[A-Za-z0-9_-]{2,15}$/.test(user)) throw new ApiError(400, 'That does not look like a Last.fm username.');
    setSetting('lastfm_username', user);
  }

  if (body.dripBatchSize !== undefined) {
    setSetting('drip_batch_size', String(intInRange(body.dripBatchSize, 1, 10, 'Drip batch size')));
    dripChanged = true;
  }
  if (body.dripIntervalSec !== undefined) {
    setSetting('drip_interval_sec', String(intInRange(body.dripIntervalSec, 15, 3600, 'Drip interval')));
    dripChanged = true;
  }
  if (body.autoSelectRelease !== undefined) setSetting('auto_select_release', body.autoSelectRelease ? '1' : '0');
  if (body.preferredReleaseCountry !== undefined) {
    const code = String(body.preferredReleaseCountry).toUpperCase();
    if (!(RELEASE_COUNTRIES as readonly string[]).includes(code)) throw new ApiError(400, 'Unsupported edition country.');
    setSetting('preferred_release_country', code);
  }
  if (body.features && typeof body.features === 'object') {
    for (const name of ['ai', 'recs', 'autocomplete', 'previews'] as (keyof FeatureFlags)[]) {
      const value = body.features[name];
      if (typeof value === 'boolean') setSetting(`feature_${name}`, value ? '1' : '0');
    }
  }

  if (lidarrChanged) invalidateProfileCache();
  if (dripChanged) restartDripWorker();
  res.json(buildSettings());
}

settingsRouter.put('/settings', ah(updateSettings));
settingsRouter.post('/settings', ah(updateSettings));

const REVEALABLE: Record<string, SecretKey> = { api_key: 'api_key', webhook_secret: 'webhook_secret' };

/** Show the external API key / webhook secret: requires the current password (rate limited). */
settingsRouter.post(
  '/settings/reveal',
  ah(async (req, res) => {
    const { which, password } = (req.body ?? {}) as { which?: string; password?: unknown };
    const name = which ? REVEALABLE[which] : undefined;
    if (!name) throw new ApiError(400, 'Only the API key or webhook secret can be revealed.');
    requireCurrentPassword(req, password);
    res.json({ value: getSecret(name) });
  }),
);

settingsRouter.post(
  '/settings/regenerate',
  ah(async (req, res) => {
    const { key, password } = (req.body ?? {}) as { key?: string; password?: unknown };
    const name = key ? REVEALABLE[key] : undefined;
    if (!name) throw new ApiError(400, 'Only the API key or webhook secret can be regenerated.');
    requireCurrentPassword(req, password);
    const value = randomToken(name === 'api_key' ? 20 : 16);
    setSecret(name, value);
    res.json({ value, settings: buildSettings() });
  }),
);

/**
 * Test Lidarr. With a typed key, any URL may be tested (the key came from the user). With the stored
 * key, only the saved URL: otherwise a session could send the stored key to a server it controls.
 */
settingsRouter.post(
  '/lidarr/test',
  ah(async (req, res) => {
    const { url, apiKey } = (req.body ?? {}) as { url?: string; apiKey?: unknown };
    const typed = secretAction(apiKey, 'Lidarr API key');
    const saved = getConnection();
    const target = (typeof url === 'string' && url.trim() ? url : (saved?.url ?? '')).trim().replace(/\/+$/, '');
    if (!target) throw new ApiError(400, 'Enter the Lidarr URL first.');
    if (!validUrl(target)) throw new ApiError(400, 'Lidarr URL must start with http:// or https://');
    let conn: { url: string; apiKey: string };
    if (typed.kind === 'set') {
      conn = { url: target, apiKey: typed.value };
    } else {
      if (!saved) throw new ApiError(400, 'Enter the Lidarr API key first.');
      if (normalizeUrl(target) !== normalizeUrl(saved.url)) {
        throw new ApiError(400, 'Re-enter the API key to test a different Lidarr URL.');
      }
      conn = saved;
    }
    const status = await getSystemStatus(conn);
    res.json({ ok: true, version: status.version, appName: status.appName ?? 'Lidarr', instanceName: status.instanceName ?? null });
  }),
);

settingsRouter.get(
  '/lidarr/profiles',
  ah(async (req, res) => {
    res.json(await getProfiles(req.query.refresh === '1'));
  }),
);

/** Tests the saved AI settings (the save itself enforces the URL/key rule above). */
settingsRouter.post(
  '/ai/test',
  ah(async (_req, res) => {
    requireFeature('ai');
    res.json({ ok: true, ...(await testAi()) });
  }),
);

/** Last.fm's endpoint is fixed, so testing with the stored key cannot leak it. */
settingsRouter.post(
  '/lastfm/test',
  ah(async (req, res) => {
    const { apiKey, username } = (req.body ?? {}) as { apiKey?: unknown; username?: unknown };
    const typed = secretAction(apiKey, 'Last.fm API key');
    if (typed.kind !== 'set' && !lastfmConfigured()) throw new ApiError(400, 'Enter your Last.fm API key first.');
    const user = typeof username === 'string' ? username.trim() : getSetting('lastfm_username');
    const result = await testLastfm(typed.kind === 'set' ? typed.value : undefined, user);
    res.json({ ok: true, ...result });
  }),
);
