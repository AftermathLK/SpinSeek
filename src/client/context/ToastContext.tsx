import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface ToastApi {
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  warning: (message: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const STYLES: Record<ToastKind, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: 'border-emerald-500/30 text-emerald-300' },
  error: { icon: XCircle, className: 'border-red-500/30 text-red-300' },
  info: { icon: Info, className: 'border-sky-500/30 text-sky-300' },
  warning: { icon: AlertTriangle, className: 'border-amber-500/30 text-amber-300' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { id, kind, message, detail }]);
      window.setTimeout(() => dismiss(id), kind === 'error' || kind === 'warning' ? 7000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, d) => push('success', m, d),
      error: (m, d) => push('error', m, d),
      info: (m, d) => push('info', m, d),
      warning: (m, d) => push('warning', m, d),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-16 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const { icon: Icon, className } = STYLES[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto flex animate-toast-in items-start gap-3 rounded-xl border bg-zinc-900/95 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur ${className}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-100">{t.message}</p>
                {t.detail && <p className="mt-0.5 whitespace-pre-line text-xs text-zinc-400">{t.detail}</p>}
              </div>
              <button className="text-zinc-500 hover:text-zinc-200" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
