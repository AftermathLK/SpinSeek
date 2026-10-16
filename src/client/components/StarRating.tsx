import { Star } from 'lucide-react';
import { memo, useState } from 'react';

interface Props {
  value: number | null;
  onChange: (value: number | null) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

/** Interactive personal 1–5 star rating. Clicking the current value clears it. */
function StarRatingInner({ value, onChange, size = 'sm', disabled }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <div
      className="inline-flex items-center"
      onMouseLeave={() => setHover(null)}
      role="radiogroup"
      aria-label="Your rating"
      title={value ? `Your rating: ${value}/5 (click again to clear)` : 'Rate this album'}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          disabled={disabled}
          className="p-0.5 text-zinc-600 transition-colors hover:scale-110 disabled:cursor-not-allowed"
          onMouseEnter={() => setHover(n)}
          onClick={(e) => {
            e.stopPropagation();
            onChange(value === n ? null : n);
          }}
        >
          <Star className={`${iconClass} ${n <= shown ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
        </button>
      ))}
    </div>
  );
}

export const StarRating = memo(StarRatingInner);
