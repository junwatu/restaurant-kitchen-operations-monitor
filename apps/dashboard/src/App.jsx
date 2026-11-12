import { ChefHat, Moon, Play, RefreshCw, Square, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InventoryPanel } from '@/components/kitchen/InventoryPanel';
import { KpiStrip } from '@/components/kitchen/KpiStrip';
import { StationBoard } from '@/components/kitchen/StationBoard';
import { TicketList } from '@/components/kitchen/TicketList';
import { Toasts } from '@/components/kitchen/Toasts';
import { api, fmtAgo } from '@/lib/kitchen';
import { cn } from '@/lib/utils';

const POLL_MS = 5000;

function readTheme() {
  try { return localStorage.getItem('kitchen-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

export default function App() {
  const [kitchen, setKitchen] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [online, setOnline] = useState(null);
  const [lastOk, setLastOk] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(readTheme);

  const [stationId, setStationIdRaw] = useState('');
  const [dishTag, setDishTagRaw] = useState('');
  const [firing, setFiring] = useState(false);
  const [pendingStation, setPendingStation] = useState(null);
  const [completingIds, setCompletingIds] = useState(() => new Set());
  const [ingredientId, setIngredientIdRaw] = useState('');
  const [qty, setQtyRaw] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Idempotency keys survive until the request succeeds, so a retry after a timeout
  // replays the same ticket/lot instead of creating a duplicate. Editing the form clears them.
  const pendingTicket = useRef(null);
  const pendingLot = useRef(null);
  const polling = useRef(false);
  const lastSimError = useRef(null);

  const notify = useCallback((text, error = false) => {
    const id = crypto.randomUUID();
    setToasts(list => [...list.slice(-2), { id, text, error }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), error ? 8000 : 3000);
  }, []);
  const dismiss = useCallback(id => setToasts(list => list.filter(t => t.id !== id)), []);

  const setStationId = v => { pendingTicket.current = null; setPendingStation(null); setStationIdRaw(v); };
  const setDishTag = v => { pendingTicket.current = null; setPendingStation(null); setDishTagRaw(v); };
  const setIngredientId = v => { pendingLot.current = null; setIngredientIdRaw(v); };
  const setQty = v => { pendingLot.current = null; setQtyRaw(v); };

  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [k, inv] = await Promise.all([api('/api/kitchen'), api('/api/inventory')]);
      setKitchen(k);
      setInventory(inv);
      setOnline(true);
      setLastOk(Date.now());
      const simError = k.simulator?.lastError;
      if (simError && simError !== lastSimError.current) notify(`Simulator stopped: ${simError}`, true);
      lastSimError.current = simError ?? null;
    } catch {
      setOnline(false);
    } finally {
      polling.current = false;
    }
  }, [notify]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('kitchen-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);

  async function settle() {
    // Wait for any in-flight poll so the post-action refresh is not skipped.
    for (let i = 0; polling.current && i < 40; i++) await new Promise(r => setTimeout(r, 50));
    await refresh();
  }

  async function fire(event) {
    event.preventDefault();
    if (firing) return;
    setFiring(true);
    pendingTicket.current ||= { ticketId: crypto.randomUUID(), stationId, dishTag: dishTag.trim().toUpperCase() };
    try {
      const result = await api('/api/tickets/fire', pendingTicket.current);
      pendingTicket.current = null;
      setPendingStation(null);
      setDishTagRaw('');
      setStationIdRaw('');
      notify(`Fired ${result.ticket.dishTag} at ${result.ticket.stationId}.`);
      await settle();
    } catch (error) {
      setPendingStation(pendingTicket.current?.stationId ?? null);
      notify(error.message, true);
    } finally {
      setFiring(false);
    }
  }

  async function complete(ticket) {
    if (completingIds.has(ticket.id)) return;
    setCompletingIds(s => new Set(s).add(ticket.id));
    try {
      const result = await api('/api/tickets/complete', { ticketId: ticket.id });
      // The server uses the dish's recipe on completion; show what came out of stock.
      const items = Object.fromEntries((inventory?.items ?? []).map(i => [i.id, i]));
      const used = (result.consumed ?? [])
        .map(c => `${c.qty} ${items[c.ingredientId]?.unit ?? ''} ${items[c.ingredientId]?.name ?? c.ingredientId}`.replace(/\s+/g, ' '))
        .join(', ');
      notify(`${ticket.dishTag} completed at ${ticket.stationId}.${used ? ` Used ${used}.` : ''}`);
      for (const warning of result.warnings ?? []) notify(warning, true);
      await settle();
    } catch (error) {
      notify(error.message, true);
    } finally {
      setCompletingIds(s => { const n = new Set(s); n.delete(ticket.id); return n; });
    }
  }

  async function receive(event) {
    event.preventDefault();
    if (receiving) return;
    setReceiving(true);
    pendingLot.current ||= { lotId: crypto.randomUUID(), ingredientId, qty: Number(qty) };
    try {
      await api('/api/inventory/receive', pendingLot.current);
      const item = inventory?.items.find(i => i.id === pendingLot.current.ingredientId);
      notify(`Received ${pendingLot.current.qty} ${item?.unit ?? ''} ${item?.name ?? ''}.`.replace(/\s+/g, ' '));
      pendingLot.current = null;
      setQtyRaw('');
      setIngredientIdRaw('');
      await settle();
    } catch (error) {
      notify(error.message, true);
    } finally {
      setReceiving(false);
    }
  }

  async function toggleSimulator() {
    if (simBusy) return;
    const running = kitchen?.simulator?.running;
    setSimBusy(true);
    try {
      await api(`/api/simulator/${running ? 'stop' : 'start'}`, {});
      notify(running ? 'Simulator stopped.' : 'Simulator started. It fires or completes a ticket every 5 seconds.');
      await settle();
    } catch (error) {
      notify(error.message, true);
    } finally {
      setSimBusy(false);
    }
  }

  async function manualRefresh() {
    setRefreshing(true);
    await settle();
    setRefreshing(false);
  }

  const tickets = kitchen?.tickets ?? [];
  const simRunning = Boolean(kitchen?.simulator?.running);
  const isDemo = kitchen?.mode === 'demo';

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <header className="sticky top-0 z-20 bg-chrome text-chrome-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ChefHat className="size-4" />
            </span>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold">Kitchen Monitor</h1>
              <p className="flex items-center gap-1.5 text-[11px] text-chrome-muted">
                <span className={cn('size-1.5 rounded-full', online === null ? 'bg-chrome-muted' : online ? 'bg-ok' : 'animate-pulse bg-late')} aria-hidden />
                {online === null ? 'Connecting…' : online ? `Live · updated ${fmtAgo(lastOk, now)}` : `Offline · last data ${lastOk ? fmtAgo(lastOk, now) : 'never'}`}
              </p>
            </div>
          </div>

          {kitchen && (
            <span
              className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', isDemo ? 'border-warn/40 text-warn' : 'border-ok/40 text-ok')}
              title={isDemo ? 'In-memory demo data. Resets when the server stops.' : 'Connected to GridDB Cloud'}
            >
              {isDemo ? 'Demo · memory only' : 'GridDB Cloud'}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggleSimulator}
              disabled={!kitchen || simBusy}
              aria-pressed={simRunning}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition-colors disabled:opacity-50',
                simRunning ? 'border-primary/50 bg-primary/15 text-primary hover:bg-primary/25' : 'border-chrome-border hover:bg-white/5',
              )}
            >
              {simRunning ? <><span className="size-2 animate-pulse rounded-full bg-primary" /> Stop simulator <Square className="size-3" /></> : <><Play className="size-3.5" /> Start simulator</>}
            </button>
            <button
              type="button"
              onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
              className="grid size-8 place-items-center rounded-md border border-chrome-border text-chrome-muted transition-colors hover:bg-white/5 hover:text-chrome-foreground"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={manualRefresh}
              className="grid size-8 place-items-center rounded-md border border-chrome-border text-chrome-muted transition-colors hover:bg-white/5 hover:text-chrome-foreground"
              aria-label="Refresh now"
              title="Refresh now"
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4 lg:px-6">
        <KpiStrip kitchen={kitchen} inventory={inventory} now={now} />

        {/* Two boards side by side, as in the blog: kitchen (stations + tickets) and inventory. */}
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-12">
          <div className="flex min-h-0 flex-col gap-3 lg:col-span-7">
            <StationBoard
              stations={kitchen?.stations ?? []}
              now={now}
              stationId={stationId}
              setStationId={setStationId}
              dishTag={dishTag}
              setDishTag={setDishTag}
              onFire={fire}
              firing={firing}
              onComplete={complete}
              completingIds={completingIds}
              pendingStation={pendingStation}
            />
          </div>
          <div className="grid min-h-0 gap-3 lg:col-span-5 lg:grid-rows-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <TicketList tickets={tickets} now={now} onComplete={complete} completingIds={completingIds} />
            <InventoryPanel
              inventory={inventory}
              ingredientId={ingredientId}
              setIngredientId={setIngredientId}
              qty={qty}
              setQty={setQty}
              onReceive={receive}
              receiving={receiving}
            />
          </div>
        </div>
      </main>

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
