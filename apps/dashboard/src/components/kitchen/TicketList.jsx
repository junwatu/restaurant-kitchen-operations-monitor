import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { elapsedMs, fmtElapsed, fmtTime, urgency } from '@/lib/kitchen';

const urgencyText = { ok: 'text-ok', warn: 'text-warn', late: 'text-late' };

// Active tickets, oldest first. Same rows as the busy station tiles, as a list.
export function TicketList({ tickets, now, onComplete, completingIds }) {
  const sorted = [...tickets].sort((a, b) => new Date(a.firedAt) - new Date(b.firedAt));
  return (
    <section id="tickets" aria-label="Active tickets" className="flex min-h-0 flex-col rounded-xl border bg-card">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Active tickets</h2>
        <span className="text-xs text-muted-foreground">{tickets.length} open · oldest first</span>
      </header>
      <ol className="scroll-thin min-h-0 flex-1 divide-y overflow-y-auto">
        {sorted.map(t => {
          const ms = elapsedMs(t.firedAt, now);
          const completing = completingIds.has(t.id);
          return (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2">
              <span className="w-8 font-mono text-xs text-muted-foreground">{t.stationId}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.dishTag}</span>
              <span className="text-xs text-muted-foreground">{fmtTime(t.firedAt)}</span>
              <span className={cn('w-12 text-right font-mono text-sm font-semibold tabular-nums', urgencyText[urgency(ms)])}>{fmtElapsed(ms)}</span>
              <button
                type="button"
                onClick={() => onComplete(t)}
                disabled={completing}
                className="grid size-7 place-items-center rounded-md border text-muted-foreground transition hover:border-ok hover:bg-ok-soft hover:text-ok disabled:opacity-50"
                aria-label={`Complete ${t.dishTag}`}
                title="Complete"
              >
                {completing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              </button>
            </li>
          );
        })}
        {!tickets.length && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No active tickets.</li>}
      </ol>
    </section>
  );
}
