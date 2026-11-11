import { Loader2, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const labelClass = 'grid gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm normal-case tracking-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function InventoryPanel({ inventory, ingredientId, setIngredientId, qty, setQty, onReceive, receiving }) {
  const items = inventory?.items ?? [];
  const sorted = [...items].sort((a, b) => (a.onHand / a.parLevel) - (b.onHand / b.parLevel));
  const selected = items.find(i => i.id === ingredientId);

  return (
    <section id="inventory" aria-label="Ingredients" className="flex min-h-0 flex-col rounded-xl border bg-card">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Ingredients</h2>
          <p className="text-xs text-muted-foreground">On hand against par. Lowest first.</p>
        </div>
        {inventory && (
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', inventory.lowCount ? 'bg-late-soft text-late' : 'bg-ok-soft text-ok')}>
            {inventory.lowCount ? `${inventory.lowCount} below par` : 'All stocked'}
          </span>
        )}
      </header>

      <ul className="scroll-thin min-h-0 flex-1 divide-y overflow-y-auto">
        {sorted.map(item => {
          // The bar spans 0 → 2× par, so the par tick sits at the midpoint.
          const pct = Math.min(100, (item.onHand / Math.max(1, item.parLevel * 2)) * 100);
          const shortfall = Math.ceil(Math.max(0, item.parLevel - item.onHand));
          return (
            <li key={item.id} className={cn('flex items-center gap-3 px-4 py-2', ingredientId === item.id && 'bg-primary-soft')}>
              <span className={cn('w-16 shrink-0 truncate text-sm font-medium', item.low && 'text-late')}>{item.name}</span>
              <span className="relative h-2 flex-1 rounded-full bg-muted" title={`${item.onHand} of par ${item.parLevel} ${item.unit}`}>
                <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500', item.low ? 'bg-late' : 'bg-ok')} style={{ width: `${pct}%` }} />
                <span className="absolute -inset-y-0.5 left-1/2 w-0.5 rounded bg-foreground/40" aria-hidden />
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
                <span className={cn('font-semibold', item.low && 'text-late')}>{item.onHand}</span>
                <span className="text-muted-foreground">/{item.parLevel} {item.unit}</span>
              </span>
              {item.low ? (
                <button
                  type="button"
                  onClick={() => { setIngredientId(item.id); setQty(String(shortfall)); }}
                  className="w-16 shrink-0 rounded-md border border-late/40 px-1.5 py-0.5 text-[11px] font-semibold text-late transition hover:bg-late-soft"
                  title={`Prefill a delivery of ${shortfall} ${item.unit} to reach par`}
                >
                  +{shortfall}
                </button>
              ) : <span className="w-16 shrink-0" />}
            </li>
          );
        })}
        {!inventory && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Loading inventory…</li>}
      </ul>

      <form onSubmit={onReceive} className="flex flex-wrap items-end gap-2 border-t bg-surface/60 p-3">
        <label className={cn(labelClass, 'min-w-32 flex-1')}>
          Receive delivery
          <select className={selectClass} value={ingredientId} onChange={e => setIngredientId(e.target.value)} required>
            <option value="">Ingredient…</option>
            {items.map(item => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
          </select>
        </label>
        <label className={cn(labelClass, 'w-24')}>
          Qty{selected ? ` (${selected.unit})` : ''}
          <Input type="number" inputMode="numeric" min="1" max="100000" step="1" value={qty} onChange={e => setQty(e.target.value)} placeholder="0" required className="bg-card font-mono" />
        </label>
        <Button type="submit" variant="secondary" disabled={receiving} className="h-9 border bg-card">
          {receiving ? <Loader2 className="animate-spin" /> : <PackagePlus />} Receive
        </Button>
      </form>
    </section>
  );
}
