// Picks the "standard" pressing of an album: official, preferred country (default US), the usual
// track count, single disc, CD/digital, and no deluxe / exclusive / signed / clean variants.
// Works on MusicBrainz releases (Editions drawer) and Lidarr releases (monitored release).

export interface ReleaseCandidate {
  key: string;
  title: string;
  disambiguation: string | null;
  status: string | null;
  countries: string[];
  formats: string[];
  trackCount: number;
  mediumCount: number;
  date: string | null;
}

export interface PreferredRelease {
  key: string;
  label: string;
}

export const RELEASE_COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'SE', 'JP', 'XW', 'XE', 'ANY'] as const;

const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  canada: 'CA',
  'united kingdom': 'GB',
  uk: 'GB',
  ireland: 'IE',
  australia: 'AU',
  'new zealand': 'NZ',
  germany: 'DE',
  france: 'FR',
  netherlands: 'NL',
  sweden: 'SE',
  japan: 'JP',
  worldwide: 'XW',
  '[worldwide]': 'XW',
  europe: 'XE',
  '[europe]': 'XE',
};

export function countryCode(value: string): string {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_NAMES[v.toLowerCase()] ?? v.toUpperCase();
}

/** Variants that are rarely what you want as the default copy. */
const STRONG_EDITION_RE =
  /\b(deluxe|expanded|special|limited|collector'?s|bonus|tour|anniversary|signed|autographed|exclusive|best ?buy|target|walmart|amazon|barnes|box ?set|super|platinum|karaoke|instrumentals?|commentary|edited|clean|censored)\b/gi;
/** Legit but less canonical pressings. */
const MILD_EDITION_RE = /\b(re-?issue|remaster(?:ed)?|club|fan|japan(?:ese)?|import|acoustic|demos?|mono)\b/gi;

function editionPenalty(text: string): number {
  const strong = new Set((text.match(STRONG_EDITION_RE) ?? []).map((m) => m.toLowerCase())).size;
  const mild = new Set((text.match(MILD_EDITION_RE) ?? []).map((m) => m.toLowerCase())).size;
  return Math.min(120, strong * 40) + Math.min(30, mild * 15);
}

function hasStrongEditionWords(c: ReleaseCandidate): boolean {
  STRONG_EDITION_RE.lastIndex = 0;
  return STRONG_EDITION_RE.test(`${c.title} ${c.disambiguation ?? ''}`);
}

function statusScore(status: string | null): number {
  switch ((status ?? '').toLowerCase()) {
    case 'official':
      return 100;
    case 'promotion':
      return -40;
    case 'bootleg':
      return -150;
    case 'pseudo-release':
      return -200;
    default:
      return 0;
  }
}

function formatScore(formats: string[]): number {
  if (formats.length === 0) return 0;
  const f = formats.join(' ').toLowerCase();
  if (/dvd|blu-?ray|vhs/.test(f)) return -20;
  if (/\bcd\b|compact disc/.test(f)) return 15;
  if (/digital/.test(f)) return 12;
  if (/sacd|hybrid/.test(f)) return 5;
  if (/vinyl|\blp\b|12"|7"/.test(f)) return 4;
  return 0;
}

function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Highest frequency wins; ties go to the smaller value (bonus tracks inflate counts).
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

function year(date: string | null): number | null {
  const y = date ? Number.parseInt(date.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) && y > 0 ? y : null;
}

function formatLabel(formats: string[]): string {
  if (formats.length === 0) return '';
  const names = formats.map((f) => f.replace('Digital Media', 'Digital').replace(/^12" Vinyl$/, 'Vinyl'));
  const unique = [...new Set(names)];
  return unique.length === 1 && names.length > 1 ? `${names.length}×${unique[0]}` : unique.join(' + ');
}

export function describeRelease(c: ReleaseCandidate, preferredCountry = ''): string {
  const codes = c.countries.map(countryCode);
  const country = codes.includes(preferredCountry) ? preferredCountry : (codes.find((x) => x.length === 2) ?? '');
  const head = [country, formatLabel(c.formats)].filter(Boolean).join(' ');
  return `${head || 'Release'} · ${c.trackCount} track${c.trackCount === 1 ? '' : 's'}`;
}

export function pickPreferredRelease(candidates: ReleaseCandidate[], preferredCountry: string): PreferredRelease | null {
  if (candidates.length === 0) return null;
  const country = preferredCountry.toUpperCase();
  const official = candidates.filter((c) => (c.status ?? '').toLowerCase() === 'official');
  const pool = official.length ? official : candidates;
  const plain = pool.filter((c) => !hasStrongEditionWords(c));
  const base = plain.length ? plain : pool;
  const local = country !== 'ANY' ? base.filter((c) => c.countries.map(countryCode).includes(country)) : [];
  const reference = local.length ? local : base;
  const standardTracks = mode(reference.map((c) => c.trackCount).filter((n) => n > 0));
  const standardMedia = mode(reference.map((c) => Math.max(1, c.mediumCount))) ?? 1;
  const firstYear = Math.min(...pool.map((c) => year(c.date) ?? 9999));

  let best: { c: ReleaseCandidate; score: number } | null = null;
  for (const c of candidates) {
    let score = statusScore(c.status);
    score -= editionPenalty(`${c.title} ${c.disambiguation ?? ''}`);
    // Any extra note ("artwork 2nd version", "jade green") loses ties against the plain pressing.
    const note = (c.disambiguation ?? '').trim();
    if (note && !/^explicit$/i.test(note)) score -= 4;
    score += formatScore(c.formats);
    if (country !== 'ANY') {
      const codes = c.countries.map(countryCode);
      // A pressing made for the country beats a digital release listed in dozens of countries.
      if (codes.includes(country)) score += codes.length > 3 ? 20 : 40;
      else if (codes.includes('XW')) score += 15;
    }
    if (standardTracks !== null && c.trackCount > 0) {
      const diff = c.trackCount - standardTracks;
      score -= diff > 0 ? diff * 6 : -diff * 4;
    }
    if (Math.max(1, c.mediumCount) > standardMedia) score -= 20;
    const y = year(c.date);
    if (y !== null && firstYear < 9999) score -= Math.min(15, (y - firstYear) * 2);

    if (
      !best ||
      score > best.score ||
      (score === best.score && (year(c.date) ?? 9999) < (year(best.c.date) ?? 9999))
    ) {
      best = { c, score };
    }
  }
  return best ? { key: best.c.key, label: describeRelease(best.c, country) } : null;
}
