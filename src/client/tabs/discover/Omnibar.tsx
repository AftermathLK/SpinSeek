import { ListPlus, Loader2, Maximize2, Minimize2, Radio, Search, Settings2, Sparkles, Square, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { useApp } from '../../context/AppContext';
import { QuickResults } from './QuickResults';
import { RecsPanel, type RecsPanelProps } from './RecsPanel';
import { MAX_BATCH_ITEMS, parseBatchQuery } from '../../../shared/parse';

export type OmnibarMode = 'standard' | 'ai' | 'recs';

export interface AiOptions {
  count: number;
  includeOwned: boolean;
  newArtistsOnly: boolean;
}

interface Props {
  inputRef: RefObject<HTMLTextAreaElement>;
  mode: OmnibarMode;
  onModeChange: (mode: OmnibarMode) => void;
  query: string;
  onQueryChange: (q: string) => void;
  prompt: string;
  onPromptChange: (p: string) => void;
  aiOptions: AiOptions;
  onAiOptionsChange: (o: AiOptions) => void;
  running: boolean;
  onSubmit: () => void;
  onStop: () => void;
  /** Search just this one item (query pill, dropdown "List Albums" / "Select"). */
  onSearchText: (text: string) => void;
  onOpenArtistByName: (name: string) => void;
  recs: Omit<RecsPanelProps, 'running' | 'onStop'>;
}

const AI_EXAMPLES = [
  'Moody 90s shoegaze I probably missed',
  'Albums that sound like a rainy night drive',
  'Pop-punk deep cuts similar to my favorites',
  'Essential 70s Brazilian records',
  'Instrumental post-rock for focus',
];

function useNarrowScreen(): boolean {
  const query = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function Omnibar(props: Props) {
  const {
    inputRef,
    mode,
    onModeChange,
    query,
    onQueryChange,
    prompt,
    onPromptChange,
    aiOptions,
    onAiOptionsChange,
    running,
    onSubmit,
    onStop,
    onSearchText,
    onOpenArtistByName,
    recs,
  } = props;
  const { settings, openSettings } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const narrow = useNarrowScreen();
  const parsed = useMemo(() => parseBatchQuery(query), [query]);
  const value = mode === 'ai' ? prompt : query;
  const isMultiline = value.includes('\n');
  const rows = expanded || isMultiline ? Math.min(10, Math.max(4, value.split('\n').length + 1)) : 1;
  const features = settings?.features ?? { ai: true, recs: true, autocomplete: true, previews: true };

  // A single item (no list): eligible for the live suggestion dropdown.
  const singleQuery = mode === 'standard' && parsed.length === 1 && !/[\n,]/.test(query) ? query.trim() : '';

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode, inputRef]);

  const submit = () => {
    setDropdownOpen(false);
    if (!running) onSubmit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') setDropdownOpen(false);
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !expanded && !isMultiline))) {
      e.preventDefault();
      submit();
    }
  };

  const aiReady = settings?.aiConfigured ?? false;
  const tabs: { id: OmnibarMode; label: string; icon: typeof Search; active: string }[] = [
    { id: 'standard', label: 'Standard / Batch', icon: Search, active: 'bg-zinc-800 text-zinc-50' },
    ...(features.ai
      ? [{ id: 'ai' as const, label: 'AI Discovery', icon: Sparkles, active: 'bg-gradient-to-r from-violet-600/80 to-fuchsia-600/80 text-white' }]
      : []),
    ...(features.recs
      ? [{ id: 'recs' as const, label: 'Recommendations', icon: Radio, active: 'bg-gradient-to-r from-sky-600/80 to-emerald-600/70 text-white' }]
      : []),
  ];

  return (
    <div className="card p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {tabs.map(({ id, label, icon: Icon, active }) => (
            <button
              key={id}
              onClick={() => onModeChange(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === id ? active : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
        {mode !== 'recs' && (
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-zinc-500 sm:flex">
            <kbd className="kbd">Ctrl</kbd>/<kbd className="kbd">⌘</kbd>+<kbd className="kbd">K</kbd> focus ·{' '}
            <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Enter</kbd> new line
          </span>
        )}
      </div>

      {mode === 'recs' ? (
        <RecsPanel {...recs} running={running} onStop={onStop} />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                rows={rows}
                value={value}
                onChange={(e) => {
                  if (mode === 'standard') {
                    onQueryChange(e.target.value);
                    setDropdownOpen(true);
                  } else onPromptChange(e.target.value);
                }}
                onFocus={() => mode === 'standard' && setDropdownOpen(true)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                placeholder={
                  mode === 'standard'
                    ? narrow
                      ? 'Artist, or Artist - Album…'
                      : 'Good Charlotte  ·  Blink-182 - Enema of the State  ·  or paste a list (one per line / comma-separated)'
                    : narrow
                      ? 'Describe what you want to hear…'
                      : 'Describe what you want to hear… e.g. "dreamy female-fronted indie from the 2010s"'
                }
                className="input min-h-[2.75rem] resize-none py-2.5 pr-10 text-[15px] leading-6"
                aria-autocomplete={mode === 'standard' && features.autocomplete ? 'list' : undefined}
              />
              <button
                type="button"
                className="absolute right-2 top-2.5 text-zinc-500 hover:text-zinc-200"
                onClick={() => setExpanded((x) => !x)}
                title={expanded ? 'Collapse' : 'Expand for batch input'}
                aria-label={expanded ? 'Collapse input' : 'Expand input'}
              >
                {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              {mode === 'standard' && features.autocomplete && (
                <QuickResults
                  query={singleQuery}
                  open={dropdownOpen && !running}
                  onClose={() => setDropdownOpen(false)}
                  onSearch={(text) => {
                    setDropdownOpen(false);
                    onSearchText(text);
                  }}
                  onOpenArtist={(name) => {
                    setDropdownOpen(false);
                    onOpenArtistByName(name);
                  }}
                />
              )}
            </div>
            {running ? (
              <button className="btn-secondary h-11 px-4" onClick={onStop}>
                <Square className="h-4 w-4 fill-current" /> Stop
              </button>
            ) : (
              <button
                className="btn-primary h-11 px-4"
                onClick={submit}
                disabled={mode === 'standard' ? parsed.length === 0 : !prompt.trim() || !aiReady}
              >
                {mode === 'standard' ? <Search className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                <span className="hidden sm:inline">{mode === 'standard' ? 'Search' : 'Discover'}</span>
              </button>
            )}
          </div>

          {mode === 'standard' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              {parsed.length > 1 && (
                <span className="pill border-violet-500/30 bg-violet-500/10 text-violet-300">
                  <ListPlus className="h-3 w-3" /> {parsed.length} queries
                </span>
              )}
              {parsed.length > MAX_BATCH_ITEMS && <span className="text-amber-300">Max {MAX_BATCH_ITEMS} per batch</span>}
              {parsed.slice(0, 8).map((p, i) => (
                <span key={i} className="inline-flex overflow-hidden rounded-full border border-zinc-700 bg-zinc-800/60 text-[11px] font-medium">
                  <button
                    type="button"
                    className="px-2 py-0.5 text-zinc-300 hover:bg-zinc-700 hover:text-white disabled:opacity-50"
                    onClick={() => onSearchText(p.raw)}
                    disabled={running}
                    title={p.album ? `Search just “${p.artist} – ${p.album}”` : `Search just ${p.artist}`}
                  >
                    {p.artist}
                    {p.album && <span className="text-zinc-500"> – {p.album}</span>}
                  </button>
                  {!p.album && (
                    <button
                      type="button"
                      className="border-l border-zinc-700 px-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-violet-200"
                      onClick={() => onOpenArtistByName(p.artist)}
                      title={`Open ${p.artist}'s artist page`}
                      aria-label={`Open ${p.artist}'s artist page`}
                    >
                      <UserRound className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {parsed.length > 8 && <span>+{parsed.length - 8} more</span>}
              {parsed.length === 0 && (
                <span>
                  Use <code className="text-zinc-400">Artist - Album</code> to target an album; wrap names containing commas in quotes.
                </span>
              )}
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
          )}

          {mode === 'ai' && (
            <div className="mt-3 space-y-3">
              {!aiReady && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  AI Discovery needs an OpenAI-compatible endpoint or a Gemini API key.
                  <button className="btn-secondary ml-auto px-2 py-1 text-xs" onClick={() => openSettings('ai')}>
                    <Settings2 className="h-3.5 w-3.5" /> Configure AI
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-300">
                <label className="flex items-center gap-2">
                  Picks
                  <select
                    className="select w-20 py-1 text-xs"
                    value={aiOptions.count}
                    onChange={(e) => onAiOptionsChange({ ...aiOptions, count: Number(e.target.value) })}
                  >
                    {[6, 12, 20, 30].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={aiOptions.includeOwned}
                    onChange={(e) => onAiOptionsChange({ ...aiOptions, includeOwned: e.target.checked })}
                  />
                  Include albums I already have
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={aiOptions.newArtistsOnly}
                    onChange={(e) => onAiOptionsChange({ ...aiOptions, newArtistsOnly: e.target.checked })}
                  />
                  New artists only
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {AI_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-violet-500/40 hover:text-violet-200"
                    onClick={() => onPromptChange(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
