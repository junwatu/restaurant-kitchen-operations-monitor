import { AlertTriangle, CheckCircle2, ChefHat, Clock3, Flame, LayoutGrid, Package, PackagePlus, Play, RefreshCw, Square, Ticket } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

async function api(path, payload) {
  const res = await fetch(path, {
    ...(payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
    signal: AbortSignal.timeout(35000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const fmtTime = v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const waiting = v => Math.max(0, Math.floor((Date.now() - new Date(v)) / 60000));

function Kpi({ icon: Icon, label, value, sub, tone }) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex items-start justify-between p-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">{value}</p>
          <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
        </div>
        <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg', tone)}>
          <Icon className="size-5" />
        </span>
      </CardContent>
    </Card>
  );
}

export default function App() {
  const [kitchen, setKitchen] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [notice, setNotice] = useState(null);
  const [stationId, setStationId] = useState('');
  const [dishTag, setDishTag] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(null);
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [k, inv] = await Promise.all([api('/api/kitchen'), api('/api/inventory')]);
      setKitchen(k);
      setInventory(inv);
    } catch (error) {
      setNotice({ text: `${error.message} Shown values may be stale.`, error: true });
    } finally {
      polling.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function fire(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    pending.current ||= {
      ticketId: crypto.randomUUID(),
      stationId,
      dishTag: dishTag.trim().toUpperCase(),
    };
    try {
      const result = await api('/api/tickets/fire', pending.current);
      pending.current = null;
      setDishTag('');
      setNotice({ text: `Fired ${result.session.vehicleTag} at ${result.session.spaceId}.` });
      await refresh();
    } catch (error) {
      setNotice({ text: error.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function complete(ticket) {
    try {
      await api('/api/tickets/complete', { ticketId: ticket.id });
      setNotice({ text: `${ticket.vehicleTag} completed.` });
      await refresh();
    } catch (error) {
      setNotice({ text: error.message, error: true });
    }
  }

  async function receive(event) {
    event.preventDefault();
    try {
      await api('/api/inventory/receive', {
        lotId: crypto.randomUUID(),
        ingredientId,
        qty: Number(qty),
      });
      setQty('');
      setNotice({ text: 'Stock received.' });
      await refresh();
    } catch (error) {
      setNotice({ text: error.message, error: true });
    }
  }

  async function toggleSimulator() {
    const running = kitchen?.simulator?.running;
    try {
      await api(`/api/simulator/${running ? 'stop' : 'start'}`, {});
      setNotice({ text: running ? 'Simulator stopped.' : 'Simulator started — it fires and completes tickets every 5 seconds.' });
      await refresh();
    } catch (error) {
      setNotice({ text: error.message, error: true });
    }
  }

  const spaces = kitchen?.spaces ?? [];
  const sessions = kitchen?.sessions ?? [];
  const free = spaces.filter(s => s.enabled && !s.session);
  const busyCount = kitchen?.stats.occupied ?? 0;
  const capacity = kitchen?.stats.capacity ?? spaces.length;
  const loadPct = capacity ? Math.round((busyCount / capacity) * 100) : 0;
  const longestWait = sessions.length ? Math.max(...sessions.map(t => waiting(t.enteredAt))) : 0;

  return (
    <div className="flex h-dvh overflow-hidden bg-zinc-100 text-zinc-900 antialiased">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-10 bg-zinc-950 text-white">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6">
            <a href="#stations" className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-orange-600">
                <ChefHat className="size-4" />
              </span>
              <span className="text-sm font-semibold leading-tight">
                Kitchen Monitor
                <span className="block text-xs font-normal text-zinc-400">
                  {kitchen ? `Updated ${fmtTime(kitchen.generatedAt)} · ${loadPct}% load` : 'Connecting…'}
                </span>
              </span>
            </a>
            <nav className="flex items-center gap-1 text-sm text-zinc-300">
              {[
                ['#stations', LayoutGrid, 'Stations'],
                ['#tickets', Ticket, 'Live tickets'],
                ['#inventory', Package, 'Inventory'],
              ].map(([href, Icon, label]) => (
                <a
                  key={href}
                  href={href}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-zinc-800 hover:text-white"
                >
                  <Icon className="size-4" /> {label}
                  {label === 'Live tickets' && sessions.length > 0 && (
                    <span className="rounded-full bg-orange-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white">{sessions.length}</span>
                  )}
                </a>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary" className="bg-zinc-800 text-zinc-200">
                {kitchen ? (kitchen.mode === 'demo' ? 'Demo · memory only' : 'GridDB Cloud') : 'Connecting'}
              </Badge>
              <Button variant="secondary" size="sm" onClick={toggleSimulator} className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700">
                {kitchen?.simulator?.running ? <><Square /> Stop simulator</> : <><Play /> Start simulator</>}
              </Button>
              <Button variant="secondary" size="sm" onClick={refresh} className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700">
                <RefreshCw /> Refresh
              </Button>
            </div>
          </div>
        </header>

        <main className="grid flex-1 gap-3 overflow-y-auto px-4 py-3 sm:px-6 lg:grid-cols-12 lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden">
          {notice && (
            <Alert className="lg:col-span-12" variant={notice.error ? 'destructive' : 'default'}>
              <span className="flex items-center gap-2">
                {notice.error && <AlertTriangle className="size-4" />}
                {notice.text}
              </span>
            </Alert>
          )}

          <section className="grid grid-cols-2 gap-3 lg:col-span-12 lg:grid-cols-4">
            <Kpi icon={Flame} label="Stations busy" value={kitchen ? `${busyCount}/${capacity}` : '—'} sub={`${free.length} free to fire`} tone="bg-orange-100 text-orange-700" />
            <Kpi icon={Ticket} label="Active tickets" value={sessions.length} sub={sessions.length ? 'On the board now' : 'Board is clear'} tone="bg-sky-100 text-sky-700" />
            <Kpi icon={Clock3} label="Longest wait" value={sessions.length ? `${longestWait} min` : '—'} sub={sessions.length ? 'Oldest live ticket' : 'No live tickets'} tone="bg-amber-100 text-amber-700" />
            <Kpi icon={Package} label="Low stock" value={inventory ? inventory.lowCount : '—'} sub={inventory?.lowCount ? 'Below par — receive stock' : 'All at or above par'} tone="bg-red-100 text-red-700" />
          </section>

          <Card id="stations" className="min-h-0 overflow-hidden shadow-none lg:col-span-4">
            <CardHeader className="flex-row items-start justify-between space-y-0 p-4 pb-2">
              <div>
                <CardTitle>Station board</CardTitle>
                <CardDescription>Select a free station, then fire a ticket.</CardDescription>
              </div>
              <Badge variant="secondary">{loadPct}% load</Badge>
            </CardHeader>
            <CardContent className="grid gap-2 p-4 pt-0">
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-orange-600 transition-all duration-500" style={{ width: `${loadPct}%` }} />
              </div>
              {['Grill', 'Fry', 'Pass'].map(zone => (
                <div key={zone}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{zone}</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {spaces.filter(s => s.zone === zone).map(s => {
                      const isBusy = Boolean(s.session);
                      const selected = stationId === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          disabled={isBusy || !s.enabled}
                          onClick={() => { pending.current = null; setStationId(s.id); }}
                          className={cn(
                            'rounded-lg border p-2 text-left transition-all',
                            isBusy ? 'border-red-200 bg-red-50/60' : 'border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm',
                            selected && 'border-orange-600 ring-2 ring-orange-600/25',
                          )}
                        >
                          <span className="flex items-center justify-between">
                            <span className="font-semibold tabular-nums">{s.id}</span>
                            <span className={cn('size-2 rounded-full', isBusy ? 'animate-pulse bg-red-500' : 'bg-emerald-500')} />
                          </span>
                          <span className="mt-1 block truncate text-sm text-muted-foreground">
                            {isBusy ? s.session.vehicleTag : 'Free'}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {isBusy ? `${waiting(s.session.enteredAt)} min · since ${fmtTime(s.session.enteredAt)}` : 'Ready'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!spaces.length && <p className="text-sm text-muted-foreground">No stations yet.</p>}
            </CardContent>
          </Card>

          <div className="grid min-h-0 content-start gap-3 lg:col-span-4">
            <Card id="fire" className="shadow-none">
              <CardHeader className="p-4 pb-2">
                <CardTitle>Fire a ticket</CardTitle>
                <CardDescription>One dish per station at a time.</CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <form onSubmit={fire} className="flex flex-wrap items-end gap-2">
                  <label className="grid min-w-40 flex-1 gap-1.5 text-sm font-medium">
                    Station
                    <select className={selectClass} value={stationId} onChange={e => { pending.current = null; setStationId(e.target.value); }} required>
                      <option value="">Choose a station</option>
                      {free.map(s => (
                        <option key={s.id} value={s.id}>{s.id} · {s.zone}</option>
                      ))}
                      {pending.current && !free.some(s => s.id === pending.current.stationId) && (
                        <option value={pending.current.stationId}>{pending.current.stationId} · pending — submit again to confirm</option>
                      )}
                    </select>
                  </label>
                  <label className="grid min-w-44 flex-1 gap-1.5 text-sm font-medium">
                    Dish tag
                    <Input value={dishTag} onChange={e => { pending.current = null; setDishTag(e.target.value); }} placeholder="e.g. BURGER-02" maxLength={16} required />
                  </label>
                  <Button type="submit" disabled={busy}>
                    <Flame /> Fire ticket
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card id="inventory" className="shadow-none">
              <CardHeader className="flex-row items-start justify-between space-y-0 p-4 pb-2">
                <div>
                  <CardTitle>Ingredients</CardTitle>
                  <CardDescription>On hand against par level.</CardDescription>
                </div>
                {inventory?.lowCount > 0 && <Badge variant="destructive">{inventory.lowCount} low</Badge>}
              </CardHeader>
              <CardContent className="grid gap-2 p-4 pt-0">
                <div className="grid gap-1.5">
                  {(inventory?.items ?? []).map(item => (
                    <div key={item.id} className="flex items-center gap-3 text-sm">
                      <span className={cn('w-20 shrink-0 font-medium', item.low && 'text-red-700')}>{item.name}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
                        <span
                          className={cn('block h-full rounded-full', item.low ? 'bg-red-500' : 'bg-emerald-500')}
                          style={{ width: `${Math.min(100, Math.round((item.onHand / Math.max(1, item.parLevel * 2)) * 100))}%` }}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                        {item.onHand} / par {item.parLevel} {item.unit}
                      </span>
                    </div>
                  ))}
                  {!inventory && <p className="text-sm text-muted-foreground">Loading inventory…</p>}
                </div>
                <form onSubmit={receive} className="flex flex-wrap gap-2 border-t pt-3">
                  <select className={cn(selectClass, 'min-w-36 flex-1')} value={ingredientId} onChange={e => setIngredientId(e.target.value)} required>
                    <option value="">Ingredient</option>
                    {(inventory?.items ?? []).map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <Input type="number" min="1" max="100000" value={qty} onChange={e => setQty(e.target.value)} placeholder="Qty" required className="w-24" />
                  <Button type="submit" variant="secondary">
                    <PackagePlus /> Receive
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          <Card id="tickets" className="min-h-0 overflow-hidden shadow-none lg:col-span-4">
            <CardHeader className="flex-row items-start justify-between space-y-0 p-4 pb-2">
              <div>
                <CardTitle>Live tickets</CardTitle>
                <CardDescription>Complete a ticket when the dish leaves the station.</CardDescription>
              </div>
              <Badge variant="secondary">{sessions.length} active</Badge>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dish</TableHead>
                    <TableHead>Station</TableHead>
                    <TableHead>Fired</TableHead>
                    <TableHead>Waiting</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map(t => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.vehicleTag}</TableCell>
                      <TableCell>{t.spaceId}</TableCell>
                      <TableCell className="tabular-nums">{fmtTime(t.enteredAt)}</TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center gap-1.5 tabular-nums', waiting(t.enteredAt) >= 20 && 'font-semibold text-red-700')}>
                          <Clock3 className="size-3.5" /> {waiting(t.enteredAt)} min
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => complete(t)}>
                          <CheckCircle2 /> Complete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!sessions.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No active tickets. Fire one to get started.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}

