import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Toasts({ toasts, dismiss }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 top-16 z-50 flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:w-80">
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.error ? 'alert' : 'status'}
          className={cn(
            'animate-toast-in pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-card px-3.5 py-3 text-sm shadow-lg',
            t.error ? 'border-late/40' : 'border-ok/30',
          )}
        >
          {t.error
            ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-late" />
            : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />}
          <p className="flex-1 leading-snug">{t.text}</p>
          <button type="button" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
