export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Called whenever a protected endpoint returns 401 (session expired). */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && err.name === 'AbortError';
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed (HTTP ${res.status})`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) message = data.error;
  } catch {
    // non-JSON body
  }
  return new ApiError(res.status, message);
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'Network error — is the Spin Seek server reachable?');
  }
  if (res.status === 401 && !url.startsWith('/api/auth/')) unauthorizedHandler?.();
  if (!res.ok) throw await parseError(res);
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // e.g. a reverse proxy answering /api/* with an HTML page
    throw new ApiError(res.status, `Unexpected non-JSON response from ${url} — check your reverse proxy / URL.`);
  }
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
  post: <T>(url: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', url, body ?? {}, signal),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** POST and consume a line-delimited JSON stream, invoking onEvent per line. */
export async function streamNdjson<E>(url: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'Network error — is the Spin Seek server reachable?');
  }
  if (res.status === 401) unauthorizedHandler?.();
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError(0, 'Streaming is not supported by this browser.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(parseLine<E>(line));
      newline = buffer.indexOf('\n');
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) onEvent(parseLine<E>(rest));
}

function parseLine<E>(line: string): E {
  try {
    return JSON.parse(line) as E;
  } catch {
    throw new ApiError(0, 'Received a malformed streaming response from the server.');
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
