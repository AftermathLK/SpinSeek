import { db, getSetting } from './db.js';
import { ApiError, UpstreamError, fetchJson } from './http.js';
import { getSecret } from './secrets.js';
import { normalizeText } from './text.js';
import type { AiPick, AiProvider } from '../shared/types.js';

const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const AI_TIMEOUT_MS = 180000;

interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getAiConfig(): AiConfig {
  const provider = (getSetting('ai_provider') === 'gemini' ? 'gemini' : 'openai') as AiProvider;
  return {
    provider,
    baseUrl: getSetting('ai_base_url').trim().replace(/\/+$/, ''),
    apiKey: getSecret('ai_api_key'),
    model: getSetting('ai_model').trim(),
  };
}

export function aiConfigured(): boolean {
  const cfg = getAiConfig();
  if (!cfg.model) return false;
  if (cfg.provider === 'gemini') return Boolean(cfg.apiKey);
  return Boolean(cfg.baseUrl);
}

export function requireAiConfig(): AiConfig {
  const cfg = getAiConfig();
  if (!cfg.model) throw new ApiError(400, 'AI model is not configured. Set it in Settings → AI.');
  if (cfg.provider === 'gemini' && !cfg.apiKey) throw new ApiError(400, 'Gemini API key is not configured.');
  if (cfg.provider === 'openai' && !cfg.baseUrl) throw new ApiError(400, 'AI base URL is not configured.');
  return cfg;
}

// ---------------------------------------------------------------------------
// Library & rating context
// ---------------------------------------------------------------------------

function favoritesContext(): string {
  const rows = db
    .prepare(
      `SELECT artist_name, album_title, year, user_rating FROM ratings
       WHERE user_rating >= 4 ORDER BY user_rating DESC, updated_at DESC LIMIT 60`,
    )
    .all() as { artist_name: string; album_title: string; year: number | null; user_rating: number }[];
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `- ${r.artist_name} — ${r.album_title}${r.year ? ` (${r.year})` : ''} ★${r.user_rating}`);
  return `The listener's favorite albums (rated 4–5 stars). Use them to infer their taste:\n${lines.join('\n')}`;
}

const EXCLUSION_BUDGET = 14000;
const NAMES_ONLY_BUDGET = 5000;

function exclusionContext(newArtistsOnly: boolean): string {
  const rows = db
    .prepare(
      `SELECT artist_name, title FROM library_albums
       WHERE status IN ('downloaded', 'partial', 'missing_monitored')
       ORDER BY artist_name COLLATE NOCASE, year`,
    )
    .all() as { artist_name: string; title: string }[];
  if (rows.length === 0) return '';

  const byArtist = new Map<string, string[]>();
  for (const r of rows) {
    const list = byArtist.get(r.artist_name);
    if (list) list.push(r.title);
    else byArtist.set(r.artist_name, [r.title]);
  }

  if (newArtistsOnly) {
    const names: string[] = [];
    let used = 0;
    for (const name of byArtist.keys()) {
      if (used + name.length + 2 > EXCLUSION_BUDGET) break;
      names.push(name);
      used += name.length + 2;
    }
    const more = byArtist.size - names.length;
    return `Artists already in the listener's library — do NOT recommend ANY album by these artists:\n${names.join('; ')}${
      more > 0 ? `\n(and ${more} more artists; prefer lesser-known discoveries)` : ''
    }`;
  }

  const lines: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  let namesUsed = 0;
  let omitted = 0;
  for (const [artist, titles] of byArtist) {
    const line = `${artist}: ${titles.join(' | ')}`;
    if (used + line.length + 1 <= EXCLUSION_BUDGET) {
      lines.push(line);
      used += line.length + 1;
    } else if (namesUsed + artist.length + 2 <= NAMES_ONLY_BUDGET) {
      overflow.push(artist);
      namesUsed += artist.length + 2;
    } else {
      omitted++;
    }
  }
  let text = `Albums already in the listener's library — do NOT recommend these exact albums (other albums by these artists are fine):\n${lines.join('\n')}`;
  if (overflow.length) text += `\nAlso owned (avoid their best-known albums): ${overflow.join('; ')}`;
  if (omitted) text += `\n(${omitted} more artists omitted for brevity)`;
  return text;
}

function buildSystemPrompt(count: number, includeOwned: boolean, newArtistsOnly: boolean): string {
  const parts = [
    `You are Spin Seek's music discovery engine: an expert music critic and crate digger with encyclopedic knowledge of recorded music.`,
    `Recommend exactly ${count} albums that answer the user's request.`,
    `Rules:
- Only recommend real, officially released albums that exist in MusicBrainz. Never invent artists or titles.
- Use the canonical album title without edition suffixes such as "Deluxe Edition" or "Remastered", and the primary credited artist name.
- Prefer full-length studio albums unless the user explicitly asks for EPs, live albums, soundtracks or compilations.
- Vary the selection: at most 2 albums by the same artist unless the user asks otherwise.
- The "reason" is one vivid sentence (max 30 words) explaining why this album fits the request and the listener's taste.
- Respond with ONLY a JSON array — no prose, no markdown code fences — in exactly this shape:
[{"artist": "String", "album": "String", "year": 2010, "reason": "1-sentence pitch"}]`,
  ];
  const fav = favoritesContext();
  if (fav) parts.push(fav);
  if (!includeOwned || newArtistsOnly) {
    const excl = exclusionContext(newArtistsOnly);
    if (excl) parts.push(excl);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | { type: string; text?: string }[] | null; reasoning_content?: string } }[];
}

async function callOpenAiCompatible(cfg: AiConfig, system: string, user: string, temperature: number | null): Promise<string> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
  };
  if (temperature !== null) body.temperature = temperature;
  try {
    const data = await fetchJson<ChatCompletionResponse>(`${cfg.baseUrl}/chat/completions`, {
      service: 'AI',
      method: 'POST',
      headers,
      body,
      timeoutMs: AI_TIMEOUT_MS,
    });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
    throw new UpstreamError(502, 'AI returned an empty response', null);
  } catch (err) {
    // Some reasoning models reject custom temperatures; retry once with the default.
    if (temperature !== null && err instanceof UpstreamError && /temperature/i.test(err.message)) {
      return callOpenAiCompatible(cfg, system, user, null);
    }
    throw err;
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

async function callGemini(cfg: AiConfig, system: string, user: string, jsonMode: boolean): Promise<string> {
  const base = cfg.baseUrl && !/api\.openai\.com/i.test(cfg.baseUrl) ? cfg.baseUrl : GEMINI_DEFAULT_BASE;
  const model = cfg.model.replace(/^models\//, '');
  const data = await fetchJson<GeminiResponse>(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    service: 'Gemini',
    method: 'POST',
    headers: { 'x-goog-api-key': cfg.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.8, ...(jsonMode ? { responseMimeType: 'application/json' } : {}) },
    },
    timeoutMs: AI_TIMEOUT_MS,
  });
  if (data?.promptFeedback?.blockReason) {
    throw new UpstreamError(502, `Gemini blocked the request (${data.promptFeedback.blockReason})`, null);
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  if (!text) throw new UpstreamError(502, `Gemini returned an empty response (${data?.candidates?.[0]?.finishReason ?? 'unknown'})`, null);
  return text;
}

async function complete(system: string, user: string, jsonMode: boolean): Promise<string> {
  const cfg = requireAiConfig();
  return cfg.provider === 'gemini' ? callGemini(cfg, system, user, jsonMode) : callOpenAiCompatible(cfg, system, user, 0.8);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    const objStart = t.indexOf('{');
    const objEnd = t.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      try {
        return JSON.parse(t.slice(objStart, objEnd + 1));
      } catch {
        // fall through
      }
    }
  }
  return null;
}

export function parsePicks(text: string, max: number): AiPick[] {
  let data = extractJson(text);
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>);
    data = values.find((v) => Array.isArray(v)) ?? null;
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const picks: AiPick[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const artist = String(obj.artist ?? obj.artist_name ?? '').trim();
    const album = String(obj.album ?? obj.title ?? obj.album_title ?? '').trim();
    if (!artist || !album) continue;
    const key = `${normalizeText(artist)}|${normalizeText(album)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const yearRaw = obj.year;
    const year = typeof yearRaw === 'number' ? yearRaw : Number.parseInt(String(yearRaw ?? ''), 10);
    picks.push({
      artist,
      album,
      year: Number.isFinite(year) && year > 1800 ? year : null,
      reason: String(obj.reason ?? obj.pitch ?? '').trim(),
    });
    if (picks.length >= max) break;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getAiPicks(prompt: string, count: number, includeOwned: boolean, newArtistsOnly: boolean): Promise<AiPick[]> {
  const system = buildSystemPrompt(count, includeOwned, newArtistsOnly);
  const text = await complete(system, prompt, true);
  const picks = parsePicks(text, count);
  if (picks.length === 0) {
    throw new UpstreamError(502, 'The AI response could not be parsed as an album list. Try again or use a stronger model.', null);
  }
  return picks;
}

export async function testAi(): Promise<{ model: string; provider: AiProvider; sample: string }> {
  const cfg = requireAiConfig();
  const text = await complete(
    'You are a connectivity test. Reply with ONLY this JSON array and nothing else: [{"artist": "Radiohead", "album": "OK Computer", "year": 1997, "reason": "test"}]',
    'Run the connectivity test.',
    true,
  );
  const picks = parsePicks(text, 1);
  return {
    model: cfg.model,
    provider: cfg.provider,
    sample: picks.length ? `${picks[0].artist} — ${picks[0].album}` : text.slice(0, 120),
  };
}
