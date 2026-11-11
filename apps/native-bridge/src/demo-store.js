import { randomUUID } from 'node:crypto';

function fail(name, message) { throw Object.assign(new Error(message), { name }); }
const DAY_MS = 86_400_000;
const DISHES = ['BURGER', 'FRIES', 'RAMEN', 'SALAD', 'PASTA', 'STEAK'];

// Explicit preview mode. Nothing in this class connects to GridDB or persists.
// Response shapes and retry rules match python/kitchen.py, so the dashboard and
// API behave the same in demo and native mode.
export class DemoStore {
  #stations = [];
  #tickets = new Map();
  #events = [];
  #history = [];
  #ingredients = [
    { id: 'TOMATO', name: 'Tomato', unit: 'kg', parLevel: 20, enabled: true },
    { id: 'CHEESE', name: 'Cheese', unit: 'kg', parLevel: 15, enabled: true },
    { id: 'FLOUR', name: 'Flour', unit: 'kg', parLevel: 30, enabled: true },
    { id: 'CHICKEN', name: 'Chicken', unit: 'kg', parLevel: 25, enabled: true },
    { id: 'BASIL', name: 'Basil', unit: 'g', parLevel: 500, enabled: true },
    { id: 'OIL', name: 'Oil', unit: 'L', parLevel: 10, enabled: true },
  ];
  #lots = new Map();
  #movements = new Map(); // keyed by movement id, insertion ordered
  #stock = [];

  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    for (const [prefix, zone] of [['G', 'Grill'], ['F', 'Fry'], ['P', 'Pass']]) {
      for (let n = 1; n <= 4; n++) {
        this.#stations.push({ id: `${prefix}0${n}`, zone, type: zone.toLowerCase(), enabled: true });
      }
    }
    // Three busy stations (G02, F02, P02) so the board is not empty on first load.
    for (const station of this.#stations.filter((_, i) => i % 4 === 1)) {
      const firedAt = new Date(this.now().getTime() - 12 * 60_000).toISOString();
      const id = randomUUID();
      this.#tickets.set(id, { id, stationId: station.id, dishTag: `DISH-${station.id}`, firedAt, completedAt: null, active: true, simulated: true });
    }
    // Tomato and chicken start below par so the low-stock state is visible.
    const seedQty = { TOMATO: 5, CHEESE: 18, FLOUR: 40, CHICKEN: 10, BASIL: 600, OIL: 12 };
    for (const ing of this.#ingredients) this.#addLot(randomUUID(), ing.id, seedQty[ing.id], 7, true);
    this.#record();
    this.#recordStock();
  }

  async request(operation, payload = {}) {
    switch (operation) {
      case 'health': return { status: 'ok', mode: 'demo', database: 'not-connected' };
      case 'snapshot': return this.snapshot();
      case 'events': return structuredClone(this.#events.slice(-100).reverse());
      case 'history': return this.#window(this.#history, payload.hours);
      case 'fire': return this.fire(payload);
      case 'complete': return this.complete(payload);
      case 'simulate': return this.simulate();
      case 'inventory': return this.inventory();
      case 'receive': return this.receive(payload);
      case 'consume': return this.consume(payload);
      case 'movements': return structuredClone([...this.#movements.values()].slice(-100).reverse());
      case 'stock_history': return this.#window(this.#stock, payload.hours);
      default: fail('ValueError', 'Unsupported demo operation');
    }
  }

  #window(series, hours) {
    const cutoff = this.now().getTime() - hours * 3_600_000;
    const points = series.filter(p => new Date(p.timestamp).getTime() > cutoff).slice(-1000);
    return { points: structuredClone(points), limit: 1000, possiblyTruncated: points.length === 1000 };
  }

  // ---- tickets ---------------------------------------------------------

  snapshot() {
    const tickets = [...this.#tickets.values()].filter(t => t.active);
    const day = this.now().toISOString().slice(0, 10);
    const completedToday = [...this.#tickets.values()].filter(t => !t.active && t.completedAt.startsWith(day)).length;
    const stations = this.#stations.map(s => ({ ...s, ticket: tickets.find(t => t.stationId === s.id) || null }));
    const capacity = stations.filter(s => s.enabled).length;
    return structuredClone({
      mode: 'demo',
      generatedAt: this.now().toISOString(),
      stations,
      tickets,
      stats: {
        capacity,
        busy: tickets.length,
        free: capacity - tickets.length,
        loadPercent: capacity ? Math.round(tickets.length / capacity * 1000) / 10 : 0,
        completedToday,
        completedTodayTruncated: false,
      },
    });
  }

  fire({ ticketId, stationId, dishTag, simulated = false }) {
    const existing = this.#tickets.get(ticketId);
    if (existing) {
      if (existing.stationId !== stationId || existing.dishTag !== dishTag) fail('ConflictError', 'Ticket ID was already used for a different order');
      return { ticket: structuredClone(existing), replayed: true, warnings: [] };
    }
    if (!this.#stations.some(s => s.id === stationId && s.enabled)) fail('LookupError', 'Station is missing or disabled');
    if ([...this.#tickets.values()].some(t => t.active && t.stationId === stationId)) fail('ConflictError', 'Station is already busy');
    const now = this.now().toISOString();
    const ticket = { id: ticketId, stationId, dishTag, firedAt: now, completedAt: null, active: true, simulated };
    this.#tickets.set(ticketId, ticket);
    this.#events.push({ id: `${ticketId}_fired`, timestamp: now, type: 'fired', stationId, ticketId, dishTag });
    this.#record();
    return { ticket: structuredClone(ticket), replayed: false, warnings: [] };
  }

  complete({ ticketId }) {
    const ticket = this.#tickets.get(ticketId);
    if (!ticket) fail('LookupError', 'Ticket not found');
    if (!ticket.active) return { ticket: structuredClone(ticket), replayed: true, warnings: [] };
    ticket.completedAt = this.now().toISOString();
    ticket.active = false;
    this.#events.push({ id: `${ticketId}_completed`, timestamp: ticket.completedAt, type: 'completed', stationId: ticket.stationId, ticketId, dishTag: ticket.dishTag });
    this.#record();
    return { ticket: structuredClone(ticket), replayed: false, warnings: [] };
  }

  simulate() {
    const snapshot = this.snapshot();
    const free = snapshot.stations.filter(s => s.enabled && !s.ticket);
    const simulated = snapshot.tickets.filter(t => t.simulated);
    const pick = list => list[Math.floor(Math.random() * list.length)];
    if (simulated.length && (!free.length || Math.random() < 0.45)) return this.complete({ ticketId: pick(simulated).id });
    if (free.length) {
      return this.fire({ ticketId: randomUUID(), stationId: pick(free).id, dishTag: `${pick(DISHES)}-${randomUUID().slice(0, 2).toUpperCase()}`, simulated: true });
    }
    this.#record();
    return { warnings: [] };
  }

  #record() {
    const busy = [...this.#tickets.values()].filter(t => t.active).length;
    this.#history.push({ timestamp: this.now().toISOString(), busy, capacity: this.#stations.filter(s => s.enabled).length });
    if (this.#history.length > 5000) this.#history.shift();
  }

  // ---- inventory -------------------------------------------------------

  #onHand() {
    const totals = {};
    for (const lot of this.#lots.values()) if (lot.active) totals[lot.ingredientId] = (totals[lot.ingredientId] || 0) + lot.qty;
    return totals;
  }

  #addLot(lotId, ingredientId, qty, expiresInDays, simulated) {
    const now = this.now();
    const lot = { id: lotId, ingredientId, qty, receivedAt: now.toISOString(), expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS).toISOString(), active: true, simulated };
    this.#lots.set(lotId, lot);
    this.#movements.set(`${lotId}_receive`, { id: `${lotId}_receive`, timestamp: lot.receivedAt, type: 'receive', ingredientId, lotId, qty });
    return lot;
  }

  #recordStock() {
    const hand = this.#onHand();
    const lowCount = this.#ingredients.filter(i => (hand[i.id] || 0) < i.parLevel).length;
    this.#stock.push({ timestamp: this.now().toISOString(), totalQty: Object.values(hand).reduce((a, b) => a + b, 0), lowCount });
    if (this.#stock.length > 5000) this.#stock.shift();
  }

  inventory() {
    const hand = this.#onHand();
    const items = this.#ingredients.map(i => ({ ...i, onHand: hand[i.id] || 0, low: (hand[i.id] || 0) < i.parLevel }));
    return structuredClone({ items, lowCount: items.filter(i => i.low).length, generatedAt: this.now().toISOString() });
  }

  receive({ lotId, ingredientId, qty, expiresInDays = 7, simulated = false }) {
    const existing = this.#lots.get(lotId);
    if (existing) {
      const original = this.#movements.get(`${lotId}_receive`)?.qty;
      if (existing.ingredientId !== ingredientId || (original !== undefined && original !== qty)) fail('ConflictError', 'Lot ID was already used for a different delivery');
      return { lot: structuredClone(existing), replayed: true, warnings: [] };
    }
    if (!this.#ingredients.some(i => i.id === ingredientId && i.enabled)) fail('LookupError', 'Ingredient is missing or disabled');
    if (!Number.isInteger(qty) || qty < 1) fail('ValueError', 'Invalid qty');
    const lot = this.#addLot(lotId, ingredientId, qty, expiresInDays, simulated);
    this.#recordStock();
    return { lot: structuredClone(lot), replayed: false, warnings: [] };
  }

  consume({ consumeId, lotId, qty, kind = 'consume' }) {
    const prior = this.#movements.get(consumeId);
    if (prior) {
      if (prior.lotId !== lotId || prior.type !== kind || prior.qty !== qty) fail('ConflictError', 'consumeId was already used for a different movement');
      return { lot: structuredClone(this.#lots.get(lotId)), replayed: true, warnings: [] };
    }
    const lot = this.#lots.get(lotId);
    if (!lot) fail('LookupError', 'Lot not found');
    if (!lot.active || lot.qty <= 0) fail('ConflictError', 'Lot is empty');
    if (qty > lot.qty) fail('ConflictError', 'Not enough stock in this lot');
    lot.qty -= qty;
    if (lot.qty === 0) lot.active = false;
    this.#movements.set(consumeId, { id: consumeId, timestamp: this.now().toISOString(), type: kind, ingredientId: lot.ingredientId, lotId, qty });
    this.#recordStock();
    return { lot: structuredClone(lot), replayed: false, warnings: [] };
  }

  async close() {}
}
