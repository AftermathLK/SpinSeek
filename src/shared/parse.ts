// Batch query parsing shared by the Omnibar (live preview) and the search API.

export interface ParsedQuery {
  raw: string;
  artist: string;
  album: string | null;
}

export const MAX_BATCH_ITEMS = 30;

/** Split on `sep` while respecting double-quoted segments ("Tyler, The Creator"). */
function splitOutsideQuotes(input: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === sep && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).trim();
  return v.replace(/"/g, '').trim();
}

/**
 * Find a spaced dash delimiter (" - ", " – ", " — ") outside quotes.
 * Bare hyphens are never treated as delimiters so names like "Blink-182" survive.
 */
function findDelimiter(input: string): { index: number; length: number } | null {
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if ((ch === '-' || ch === '–' || ch === '—') && /\s/.test(input[i - 1] ?? '') && /\s/.test(input[i + 1] ?? '')) {
      return { index: i - 1, length: 3 };
    }
  }
  return null;
}

/** Quote a name so the batch parser keeps it whole ("Tyler, The Creator", titles containing " - "). */
export function quoteForQuery(value: string): string {
  const v = value.replace(/"/g, '').trim();
  return /,|\s[-–—]\s/.test(v) ? `"${v}"` : v;
}

export function parseItem(raw: string): ParsedQuery {
  const delim = findDelimiter(raw);
  if (delim) {
    const artist = stripQuotes(raw.slice(0, delim.index));
    const album = stripQuotes(raw.slice(delim.index + delim.length));
    if (artist && album) return { raw, artist, album };
  }
  return { raw, artist: stripQuotes(raw), album: null };
}

/**
 * Multi-line input splits on newlines only (titles may contain commas);
 * single-line input splits on commas outside quotes.
 */
export function parseBatchQuery(input: string): ParsedQuery[] {
  const text = input.trim();
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pieces = lines.length > 1 ? lines : splitOutsideQuotes(lines[0] ?? '', ',');
  const seen = new Set<string>();
  const result: ParsedQuery[] = [];
  for (const piece of pieces) {
    const parsed = parseItem(piece);
    if (!parsed.artist) continue;
    const key = `${parsed.artist.toLowerCase()}|${(parsed.album ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(parsed);
  }
  return result;
}
