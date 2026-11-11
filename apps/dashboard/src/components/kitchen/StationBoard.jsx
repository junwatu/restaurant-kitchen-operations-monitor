import { Check, Flame, Loader2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { dishEmoji, elapsedMs, fmtElapsed, fmtTime, LATE_MIN, QUICK_DISHES, urgency, ZONES } from '@/lib/kitchen';

const urgencyStyles = {
  ok: { tile: 'border-ok/40 bg-ok-soft', bar: 'bg-ok', text: 'text-ok', dot: 'bg-ok' },
  warn: { tile: 'border-warn/50 bg-warn-soft', bar: 'bg-warn', text: 'text-warn', dot: 'bg-warn' },
  late: { tile: 'border-late/50 bg-late-soft', bar: 'bg-late', text: 'text-late', dot: 'bg-late animate-pulse' },
};

function BusyTile({ station, now, onComplete, completing }) {
  const ms = elapsedMs(station.ticket.firedAt, now);
  const level = urgency(ms);
  const s = urgencyStyles[level];
  const pct = Math.min(100, (ms / (LATE_MIN * 60000)) * 100);
  return (
    <div
      className={cn('animate-tile-in relative flex min-h-24 flex-col justify-between gap-1 overflow-hidden rounded-lg border p-2 lg:min-h-[76px]', s.tile)}
      title={`${station.ticket.dishTag} · fired ${fmtTime(station.ticket.firedAt)}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-xs font-semibold tracking-wide">
          <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
          {station.id}
        </span>
        <button
          type="button"
          onClick={() => onComplete(station.ticket)}
          disabled={completing}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-card/80 px-1.5 text-[11px] font-semibold text-foreground shadow-sm ring-1 ring-border transition hover:bg-card disabled:opacity-60"
          aria-label={`Complete ${station.ticket.dishTag} at ${station.id}`}
        >
          {completing ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Done
        </button>
      </div>
      <div className="flex min-h-0 items-center gap-2">
        <span className="text-2xl leading-none xl:text-3xl" role="img" aria-label={station.ticket.dishTag.split('-')[0].toLowerCase()}>
          {dishEmoji(station.ticket.dishTag)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{station.ticket.dishTag}</p>
          <p className={cn('font-mono text-base font-semibold leading-tight tabular-nums', s.text)}>{fmtElapsed(ms)}</p>
        </div>
      </div>
      <span className="absolute inset-x-0 bottom-0 h-1 bg-foreground/5">
        <span className={cn('block h-full transition-[width] duration-1000 ease-linear', s.bar)} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function FreeTile({ station, selected, onSelect }) {
  return (
    <button
      type="button"
      disabled={!station.enabled}
      onClick={() => onSelect(selected ? '' : station.id)}
      aria-pressed={selected}
      aria-label={`Station ${station.id}, ${station.enabled ? 'free' : 'disabled'}${selected ? ', selected' : ''}`}
      className={cn(
        'group flex min-h-24 flex-col justify-between rounded-lg border border-dashed p-2 text-left transition-all lg:min-h-[76px]',
        'hover:border-primary/60 hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-40',
        selected ? 'border-solid border-primary bg-primary-soft ring-2 ring-primary/25' : 'bg-surface/50',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold tracking-wide">{station.id}</span>
        <span className={cn('size-2 rounded-full', station.enabled ? 'bg-muted-foreground/30' : 'bg-muted-foreground/60')} aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-medium text-muted-foreground group-hover:text-primary">
          {!station.enabled ? 'Disabled' : selected ? 'Selected' : 'Free'}
        </span>
        <span className="block text-[11px] text-muted-foreground">{station.enabled ? (selected ? 'Add a dish below' : 'Tap to fire') : 'Off line'}</span>
      </span>
    </button>
  );
}

// Dish tag = dish name plus a random order number, e.g. RAMEN-37 (fits the 16-char limit).
const randomTag = dish => `${dish}-${Math.floor(10 + Math.random() * 90)}`;

export function StationBoard({
  stations, now, stationId, setStationId, dishTag, setDishTag, onFire, firing, onComplete, completingIds, pendingStation,
}) {
  const inputRef = useRef(null);
  const free = stations.filter(s => s.enabled && !s.ticket);
  const selected = stations.find(s => s.id === stationId);

  useEffect(() => {
    if (stationId) inputRef.current?.focus();
  }, [stationId]);

  return (
    <section id="stations" aria-label="Station board" className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">Station board</h2>
          <p className="text-xs text-muted-foreground">Pick a free station and a dish, then fire. Tap Done when it leaves.</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Legend className="bg-ok" label="On time" />
          <Legend className="bg-warn" label="10+ min" />
          <Legend className="bg-late" label="20+ min" />
        </div>
      </header>

      {/* On desktop the three zones split the board height evenly and tiles stretch to fill it,
          so every station stays visible without scrolling. Scroll is only a fallback for tiny windows. */}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {ZONES.map(zone => {
          const list = stations.filter(s => s.zone === zone);
          if (!list.length) return null;
          const busy = list.filter(s => s.ticket).length;
          return (
            <div key={zone} className="flex flex-col lg:flex-[1_0_auto]">
              <div className="mb-1 flex items-center gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{zone}</h3>
                <span className="h-px flex-1 bg-border" />
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{busy}/{list.length}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex-1 lg:auto-rows-fr">
                {list.map(s => (s.ticket
                  ? <BusyTile key={s.id} station={s} now={now} onComplete={onComplete} completing={completingIds.has(s.ticket.id)} />
                  : <FreeTile key={s.id} station={s} selected={stationId === s.id} onSelect={setStationId} />))}
              </div>
            </div>
          );
        })}
        {!stations.length && <p className="py-10 text-center text-sm text-muted-foreground">No stations yet. Run <code className="font-mono">npm run seed</code>.</p>}
      </div>

      <form id="fire" onSubmit={onFire} className="border-t bg-surface/60 p-3" aria-label="Fire a ticket">
        <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Station"
              className="h-9 w-36 rounded-md border border-input bg-card px-2.5 font-mono text-sm normal-case tracking-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={stationId}
              onChange={e => setStationId(e.target.value)}
              required
            >
              <option value="">{free.length ? 'Station…' : 'All busy'}</option>
              {free.map(s => <option key={s.id} value={s.id}>{s.id} · {s.zone}</option>)}
              {pendingStation && !free.some(s => s.id === pendingStation) && (
                <option value={pendingStation}>{pendingStation} · retry</option>
              )}
            </select>
            <span className="relative min-w-40 flex-1">
              <Input
                aria-label="Dish tag"
                ref={inputRef}
                value={dishTag}
                onChange={e => setDishTag(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Escape') { setStationId(''); setDishTag(''); } }}
                placeholder="Dish tag, e.g. BURGER-12"
                maxLength={16}
                pattern="[A-Za-z0-9 \-]{1,16}"
                title="1–16 letters, digits, spaces or hyphens"
                required
                className="bg-card pr-9 font-mono"
              />
              {(stationId || dishTag) && (
                <button type="button" onClick={() => { setStationId(''); setDishTag(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear">
                  <X className="size-3.5" />
                </button>
              )}
            </span>
          <Button type="submit" disabled={firing || !stationId || !dishTag.trim()} className="h-9 min-w-32">
            {firing ? <Loader2 className="animate-spin" /> : <Flame />}
            {selected ? `Fire at ${selected.id}` : 'Fire ticket'}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Pick a dish:</span>
          {QUICK_DISHES.map(dish => (
            <button
              key={dish}
              type="button"
              onClick={() => { setDishTag(randomTag(dish)); inputRef.current?.focus(); }}
              className="rounded-full border bg-card px-2.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground transition hover:border-primary/60 hover:text-primary"
            >
              {dish}
            </button>
          ))}
        </div>
      </form>
    </section>
  );
}

function Legend({ className, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', className)} /> {label}
    </span>
  );
}
