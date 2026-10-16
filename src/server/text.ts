// Title / name normalization used for canonical deduplication and fuzzy matching.

const EDITION_RE =
  /\b(deluxe|super deluxe|remaster(?:ed)?|remastered version|anniversary|expanded|special|collector'?s|bonus|re-?issue|legacy|definitive|platinum|limited|tour|edition|redux|reloaded|complete|\d{4} mix|bonus tracks?)\b/i;

/** Strip "(Deluxe Edition)", "[Remastered]", " - 2015 Remaster" style qualifiers. */
export function stripEditionQualifiers(title: string): { base: string; isEditionTitle: boolean } {
  let changed = false;
  let t = title.replace(/\s*[([]([^)\]]*)[)\]]/g, (match, inner: string) => {
    if (EDITION_RE.test(inner)) {
      changed = true;
      return '';
    }
    return match;
  });
  t = t.replace(/\s+[-–—:]\s+([^-–—:]+)$/, (match, inner: string) => {
    if (EDITION_RE.test(inner)) {
      changed = true;
      return '';
    }
    return match;
  });
  const base = t.trim();
  return { base: base || title.trim(), isEditionTitle: changed };
}

export function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

export function normalizeTitle(title: string): string {
  return normalizeText(stripEditionQualifiers(title).base);
}

function tokens(value: string): string[] {
  return [...new Set(normalizeText(value).split(' ').filter(Boolean))];
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Tokens match exactly, or within 1 typo (4+ chars) / 2 typos (8+ chars). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 4) return false;
  const max = len >= 8 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

/** Typo-tolerant token Jaccard similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const used = new Set<number>();
  let inter = 0;
  for (const t of ta) {
    const idx = tb.findIndex((u, i) => !used.has(i) && tokensMatch(t, u));
    if (idx >= 0) {
      used.add(idx);
      inter++;
    }
  }
  return inter / (ta.length + tb.length - inter);
}

/** Same name after normalization, ignoring spacing ("blink 182" = "blink‐182" = "Blink182"). */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeText(a).replace(/ /g, '');
  const nb = normalizeText(b).replace(/ /g, '');
  return na.length > 0 && na === nb;
}

/** Lucene terms with fuzzy (~) matching on longer words, for typo-tolerant MusicBrainz queries. */
export function fuzzyLuceneTerms(value: string): string {
  return escapeLuceneTerms(value)
    .split(' ')
    .filter(Boolean)
    .map((t) => (t.length >= 4 ? `${t}~` : t))
    .join(' ');
}

export function yearFromDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/** Escape a value for use inside a quoted Lucene phrase. */
export function escapeLucenePhrase(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape Lucene special characters for unquoted (fuzzy) terms. */
export function escapeLuceneTerms(value: string): string {
  return value
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
