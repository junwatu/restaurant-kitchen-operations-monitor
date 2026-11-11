import { cn } from '@/lib/utils';
import { fmtElapsed, urgency } from '@/lib/kitchen';

const toneText = { ok: 'text-ok', warn: 'text-warn', late: 'text-late', muted: '' };

function Stat({ label, value, tone = 'muted' }) {
  return (
    <div className="flex items-baseline gap-2 px-4 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('font-mono text-sm font-semibold tabular-nums', toneText[tone])}>{value}</span>
    </div>
  );
}

// One compact summary row: everything here is derived from /api/kitchen and /api/inventory.
export function KpiStrip({ kitchen, inventory, now }) {
  const stats = kitchen?.stats;
  const tickets = kitchen?.tickets ?? [];
  const oldest = tickets.reduce((acc, t) => Math.max(acc, now - new Date(t.firedAt).getTime()), 0);
  const dash = '—';

  return (
    <section aria-label="Kitchen summary" className="flex flex-wrap divide-x rounded-lg border bg-card">
      <Stat label="Stations busy" value={stats ? `${stats.busy}/${stats.capacity}` : dash} />
      <Stat label="Active tickets" value={kitchen ? tickets.length : dash} />
      <Stat label="Longest wait" value={tickets.length ? fmtElapsed(oldest) : dash} tone={tickets.length ? urgency(oldest) : 'muted'} />
      <Stat label="Completed today" value={stats ? stats.completedToday + (stats.completedTodayTruncated ? '+' : '') : dash} />
      <Stat label="Low stock" value={inventory ? inventory.lowCount : dash} tone={inventory?.lowCount ? 'late' : 'muted'} />
    </section>
  );
}
