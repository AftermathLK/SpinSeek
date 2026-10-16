import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Error that maps cleanly onto a `{ error }` JSON response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Error raised when an upstream service (Lidarr, MusicBrainz, Deezer, AI) fails. */
export class UpstreamError extends ApiError {
  constructor(
    status: number,
    message: string,
    public readonly upstreamStatus: number | null,
    public readonly timedOut = false,
  ) {
    super(status, message);
    this.name = 'UpstreamError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Validation message from a JSON error body (e.g. Lidarr's [{ errorMessage }]). Never returns raw body
 * text: responses from user-configured URLs must not become a channel for reading arbitrary servers.
 */
function validationMessage(text: string): string | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as unknown;
    let msg: string | null = null;
    if (Array.isArray(data)) {
      msg = data
        .map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>).errorMessage : null))
        .filter((m): m is string => typeof m === 'string')
        .join('; ');
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const nested = obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>).message : null;
      const direct = ['message', 'errorMessage'].map((k) => obj[k]).find((v) => typeof v === 'string');
      msg = (typeof nested === 'string' ? nested : (direct as string | undefined)) ?? null;
    }
    const clean = msg?.replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 160) : null;
  } catch {
    return null;
  }
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized, check the API key';
  if (status === 404) return 'not found, check the URL';
  if (status === 429) return 'rate limited, try again shortly';
  if (status >= 500) return 'server error';
  return 'request rejected';
}

function networkError(service: string, err: unknown, timeoutMs: number, signal?: AbortSignal): Error {
  if (signal?.aborted) return abortError();
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new UpstreamError(504, `${service} timed out after ${Math.round(timeoutMs / 1000)}s`, null, true);
  }
  const code = e?.cause?.code;
  if (code === 'ECONNREFUSED') return new UpstreamError(502, `${service} is unreachable (connection refused)`, null);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new UpstreamError(502, `${service} host could not be resolved`, null);
  if (code === 'ECONNRESET') return new UpstreamError(502, `${service} reset the connection`, null);
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new UpstreamError(502, `${service} TLS certificate error (${code})`, null);
  }
  const detail = e?.cause?.message || e?.message || 'network error';
  return new UpstreamError(502, `${service} request failed: ${detail}${code ? ` (${code})` : ''}`, null);
}

export interface FetchJsonOptions {
  service: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Connection tests against user-typed URLs: report only the HTTP status, never upstream messages. */
  hideDetail?: boolean;
}

/** fetch() wrapper with timeout, upstream error mapping and JSON parsing. Never throws raw network errors. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const { service, method = 'GET', headers = {}, body, timeoutMs = 15000, signal, hideDetail = false } = opts;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let res: globalThis.Response;
  let text = '';
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });
    text = await res.text();
  } catch (err) {
    throw networkError(service, err, timeoutMs, signal);
  }

  if (!res.ok) {
    const isValidation = res.status === 400 || res.status === 409 || res.status === 422;
    const detail = !hideDetail && isValidation ? validationMessage(text) : null;
    if (text) console.warn(`[upstream] ${service} HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    throw new UpstreamError(502, `${service}: ${statusHint(res.status)} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(502, `${service} returned a non-JSON response (is the URL correct?)`, res.status);
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Line-delimited JSON streaming for progressive search results. */
export interface NdjsonStream {
  send(event: unknown): void;
  end(): void;
  readonly closed: boolean;
  readonly signal: AbortSignal;
}

export function startNdjson(res: Response): NdjsonStream {
  const controller = new AbortController();
  let closed = false;
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.on('close', () => {
    closed = true;
    controller.abort();
  });
  return {
    send(event: unknown) {
      if (!closed) res.write(`${JSON.stringify(event)}\n`);
    },
    end() {
      if (!closed) {
        closed = true;
        res.end();
      }
    },
    get closed() {
      return closed;
    },
    signal: controller.signal,
  };
}

/** Run async tasks with bounded concurrency, preserving result order. */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Spaces out task starts by `intervalMs`, with optional priority and abort support. */
export class SpacedQueue {
  private tasks: {
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    priority: number;
    signal?: AbortSignal;
  }[] = [];
  private lastStart = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs: number) {}

  get size(): number {
    return this.tasks.length;
  }

  run<T>(fn: () => Promise<T>, opts: { priority?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const task = {
        fn,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority: opts.priority ?? 0,
        signal: opts.signal,
      };
      let idx = this.tasks.length;
      while (idx > 0 && this.tasks[idx - 1].priority < task.priority) idx--;
      this.tasks.splice(idx, 0, task);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer || this.tasks.length === 0) return;
    const wait = Math.max(0, this.lastStart + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.next();
    }, wait);
  }

  private next(): void {
    let task = this.tasks.shift();
    while (task && task.signal?.aborted) {
      task.reject(abortError());
      task = this.tasks.shift();
    }
    if (!task) return;
    this.lastStart = Date.now();
    const current = task;
    Promise.resolve()
      .then(() => current.fn())
      .then(current.resolve, current.reject);
    this.schedule();
  }
}
