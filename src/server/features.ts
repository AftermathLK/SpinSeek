// Feature toggles (Settings → Features & Interface). Disabled features are hidden in the UI and their routes refuse requests.
import { getSetting } from './db.js';
import { ApiError } from './http.js';
import type { FeatureFlags } from '../shared/types.js';

export function features(): FeatureFlags {
  return {
    ai: getSetting('feature_ai') !== '0',
    recs: getSetting('feature_recs') !== '0',
    autocomplete: getSetting('feature_autocomplete') !== '0',
    previews: getSetting('feature_previews') !== '0',
  };
}

const LABELS: Record<keyof FeatureFlags, string> = {
  ai: 'AI Discovery',
  recs: 'Recommendations & Last.fm',
  autocomplete: 'Live search autocomplete',
  previews: 'Audio previews',
};

export function requireFeature(name: keyof FeatureFlags): void {
  if (!features()[name]) throw new ApiError(403, `${LABELS[name]} is turned off in Settings → Features & Interface.`);
}
