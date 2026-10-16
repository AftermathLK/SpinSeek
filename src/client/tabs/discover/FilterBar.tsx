import { Check, CheckSquare, ListChecks, Square, Trash2 } from 'lucide-react';
import { FILTER_LABELS, type FilterKey, type Filters } from './model';

interface Props {
  filters: Filters;
  onToggle: (key: FilterKey) => void;
  counts: Record<FilterKey, number>;
  onSelectStudio: () => void;
  onSelectMissing: () => void;
  onDeselectAll: () => void;
  onClearResults: () => void;
  selectedCount: number;
  visibleCount: number;
  totalCount: number;
}

export function FilterBar(props: Props) {
  const { filters, onToggle, counts, onSelectStudio, onSelectMissing, onDeselectAll, onClearResults, selectedCount, visibleCount, totalCount } =
    props;
  return (
    <div className="sticky top-14 z-20 -mx-4 space-y-2 border-b border-zinc-800/60 bg-zinc-950/90 px-4 py-3 backdrop-blur">
      <div className="flex flex-wrap gap-1.5">
        {FILTER_LABELS.map(({ key, label }) => {
          const active = filters[key];
          return (
            <button
              key={key}
              onClick={() => onToggle(key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              }`}
              aria-pressed={active}
            >
              <span
                className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                  active ? 'border-violet-400 bg-violet-500 text-white' : 'border-zinc-600'
                }`}
              >
                {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              {label}
              {counts[key] > 0 && <span className="text-[10px] text-zinc-500">{counts[key]}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onSelectStudio}>
          <ListChecks className="h-3.5 w-3.5" /> Select All Studio
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onSelectMissing}>
          <CheckSquare className="h-3.5 w-3.5" /> Select All Missing
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onDeselectAll} disabled={selectedCount === 0}>
          <Square className="h-3.5 w-3.5" /> Deselect All
        </button>
        <span className="ml-auto text-zinc-500">
          {visibleCount} shown{totalCount > visibleCount ? ` · ${totalCount - visibleCount} hidden by filters` : ''}
          {selectedCount > 0 && <span className="text-violet-300"> · {selectedCount} selected</span>}
        </span>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={onClearResults} title="Clear all results">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
