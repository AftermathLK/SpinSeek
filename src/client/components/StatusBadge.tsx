import { CheckCircle2, CircleDashed, CircleOff, Clock, EyeOff, PieChart } from 'lucide-react';
import type { LidarrStatus } from '../../shared/types';

const MAP: Record<LidarrStatus, { label: string; className: string; icon: typeof Clock }> = {
  downloaded: { label: 'Downloaded', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', icon: CheckCircle2 },
  missing_monitored: { label: 'Monitored / Missing', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', icon: Clock },
  partial: { label: 'Partial', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', icon: PieChart },
  unmonitored: { label: 'Unmonitored', className: 'border-sky-500/30 bg-sky-500/10 text-sky-300', icon: EyeOff },
  not_in_lidarr: { label: 'Not in Lidarr', className: 'border-zinc-700 bg-zinc-800/60 text-zinc-400', icon: CircleOff },
};

export function StatusBadge({ status, percent }: { status: LidarrStatus; percent?: number }) {
  const { label, className, icon: Icon } = MAP[status] ?? MAP.not_in_lidarr;
  return (
    <span className={`pill ${className}`}>
      <Icon className="h-3 w-3" />
      {status === 'partial' && typeof percent === 'number' ? `Partial ${Math.round(percent)}%` : label}
    </span>
  );
}

export function CutoffBadge() {
  return (
    <span className="pill border-orange-500/30 bg-orange-500/10 text-orange-300" title="Quality cutoff not met">
      <CircleDashed className="h-3 w-3" />
      Cutoff Unmet
    </span>
  );
}

export function statusLabel(status: LidarrStatus): string {
  return MAP[status]?.label ?? 'Unknown';
}
