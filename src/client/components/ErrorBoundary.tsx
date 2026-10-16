import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Short name of the section, shown in the fallback ("Library", "Settings"). */
  label?: string;
  /** Render nothing on error (for floating widgets like the mini player). */
  silent?: boolean;
}

interface State {
  error: Error | null;
}

/** Contains render errors to one section so a bug never blanks the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[spinseek] UI error in ${this.props.label ?? 'app'}:`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="mx-auto my-8 max-w-lg rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm">
        <p className="flex items-center gap-2 font-semibold text-red-200">
          <AlertTriangle className="h-4 w-4" />
          {this.props.label ? `${this.props.label} hit an unexpected error` : 'Something went wrong'}
        </p>
        <p className="mt-2 break-words font-mono text-xs text-red-300/80">{error.message}</p>
        <div className="mt-4 flex gap-2">
          <button className="btn-secondary" onClick={() => this.setState({ error: null })}>
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
          <button className="btn-ghost" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
