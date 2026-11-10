import { randomUUID } from 'node:crypto';

function fail(name, message) { throw Object.assign(new Error(message), { name }); }
const ZONES = { G: 'Grill', F: 'Fry', P: 'Pass' };

// Explicit preview mode. Nothing in this class connects to GridDB or persists.
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
  #movements = [];
  #stock = [];
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    for (const [prefix, zone] of [['G', 'Grill'], ['F', 'Fry'], ['P', 'Pass']]) {
      for (let n = 1; n <= 4; n++) {
        this.#stations.push({ id: `${prefix}0${n}`, zone, type: zone.toLowerCase(), enabled: true });
      }
    }
    for (const station of this.#stations.filter((_, i) => i % 4 === 1)) {
      const firedAt = new Date(this.now().getTime() - 12 * 60_000).toISOString();
      const id = randomUUID();
      this.#tickets.set(id, { id, spaceId: station.id, vehicleTag: `DISH-${station.id}`, enteredAt: firedAt, exitedAt: firedAt, active: true, simulated: true });
    }
    const seedQty = { TOMATO: 5, CHEESE: 18, FLOUR: 40, CHICKEN: 10, BASIL: 600, OIL: 12 };
    for (const ing of this.#ingredients) {
      const id = randomUUID();
      const now = this.now().toISOString();
      this.#lots.set(id, { id, ingredientId: ing.id, qty: seedQty[ing.id] ?? 10, receivedAt: now, active: true, simulated: true });
      this.#movements.push({ id: `${id}_receive`, timestamp: now, type: 'receive', ingredientId: ing.id, lotId: id, qty: seedQty[ing.id] ?? 10 });
    }
    this.#record();
    this.#recordStock();
  }
  #onHand() {
    const totals = {};
    for (const lot of this.#lots.values()) if (lot.active) totals[lot.ingredientId] = (totals[lot.ingredientId] || 0) + lot.qty;
    return totals;
  }
  inventory() {
    const hand = this.#onHand();
    const items = this.#ingredients.map(i => ({ ...i, onHand: hand[i.id] || 0, low: (hand[i.id] || 0) < i.parLevel }));
    return structuredClone({ items, lowCount: items.filter(i => i.low).length, generatedAt: this.now().toISOString() });
  }
  async request(operation, payload = {}) {
    switch (operation) {
      case 'health': return { status: 'ok', mode: 'demo', database: 'not-connected' };
      case 'snapshot': return this.snapshot();
      case 'events': return structuredClone(this.#events.slice(-100).reverse());
      case 'history': {
        const cutoff = this.now().getTime() - payload.hours * 3_600_000;
        const points = this.#history.filter(p => new Date(p.timestamp).getTime() > cutoff);
        return { points: structuredClone(points.slice(-1000)), limit: 1000, possiblyTruncated: points.length >= 1000 };
      }
      case 'fire': return this.fire(payload);
      case 'complete': return this.complete(payload);
      case 'simulate': return this.simulate();
      case 'inventory': return this.inventory();
      case 'receive': return this.receive(payload);
      case 'consume': return this.consume(payload);
      case 'movements': return structuredClone(this.#movements.slice(-100).reverse());
      case 'stock_history': {
        const cutoff = this.now().getTime() - payload.hours * 3_600_000;
        const points = this.#stock.filter(p => new Date(p.timestamp).getTime() > cutoff);
        return { points: structuredClone(points.slice(-1000)), limit: 1000, possiblyTruncated: points.length >= 1000 };
      }
      default: fail('ValueError', 'Unsupported demo operation');
    }
  }
  snapshot() {
    const sessions = [...this.#tickets.values()].filter(s => s.active);
    const day = this.now().toISOString().slice(0, 10);
    const completed = [...this.#tickets.values()].filter(s => !s.active && s.exitedAt.startsWith(day));
    const spaces = this.#stations.map(s => ({ ...s, session: sessions.find(p => p.spaceId === s.id) || null }));
    return structuredClone({ mode: 'demo', generatedAt: this.now().toISOString(), spaces, sessions, stats: { capacity: spaces.length, occupied: sessions.length, available: spaces.length - sessions.length, occupancyPercent: Math.round(sessions.length / spaces.length * 1000) / 10, completedToday: completed.length, revenueTruncated: false, revenueTodayCents: 0 } });
  }
  fire({ ticketId, spaceId, stationId, dishTag, vehicleTag, simulated = false }) {
    const sid = ticketId;
    const st = stationId || spaceId;
    const dish = dishTag || vehicleTag;
    const existing = this.#tickets.get(sid);
    if (existing) {
      if (existing.spaceId !== st || existing.vehicleTag !== dish) fail('ConflictError', 'Ticket ID was already used for a different order');
      return { session: structuredClone(existing), replayed: true, warnings: [] };
    }
    if (!this.#stations.some(s => s.id === st)) fail('LookupError', 'Station is missing or disabled');
    const active = [...this.#tickets.values()].filter(s => s.active);
    if (active.some(s => s.spaceId === st)) fail('ConflictError', 'Station is already busy');
    const now = this.now().toISOString();
    const session = { id: sid, spaceId: st, vehicleTag: dish, enteredAt: now, exitedAt: now, active: true, simulated };
    this.#tickets.set(sid, session);
    this.#events.push({ id: `${sid}_fired`, timestamp: now, type: 'fired', spaceId: st, sessionId: sid, vehicleTag: dish, feeCents: 0 });
    this.#record();
    return { session: structuredClone(session), replayed: false, warnings: [] };
  }
  complete({ ticketId, sessionId }) {
    const sid = ticketId || sessionId;
    const session = this.#tickets.get(sid);
    if (!session) fail('LookupError', 'Ticket not found');
    if (!session.active) return { session: structuredClone(session), replayed: true, warnings: [] };
    session.exitedAt = this.now().toISOString();
    session.active = false;
    this.#events.push({ id: `${sid}_completed`, timestamp: session.exitedAt, type: 'completed', spaceId: session.spaceId, sessionId: sid, vehicleTag: session.vehicleTag, feeCents: 0 });
    this.#record();
    return { session: structuredClone(session), replayed: false, warnings: [] };
  }
  simulate() {
    const snapshot = this.snapshot();
    const available = snapshot.spaces.filter(s => !s.session);
    const simulated = snapshot.sessions.filter(s => s.simulated);
    if (simulated.length && (!available.length || Math.random() < 0.45)) return this.complete({ ticketId: simulated[Math.floor(Math.random() * simulated.length)].id });
    if (available.length) {
      const pick = available[Math.floor(Math.random() * available.length)];
      return this.fire({ ticketId: randomUUID(), stationId: pick.id, dishTag: `SIM-${randomUUID().slice(0, 6).toUpperCase()}`, simulated: true });
    }
    this.#record();
    return { warnings: [] };
  }
  #record() {
    this.#history.push({ timestamp: this.now().toISOString(), occupied: [...this.#tickets.values()].filter(s => s.active).length, capacity: this.#stations.length });
    if (this.#history.length > 5000) this.#history.shift();
  }
  #recordStock() {
    const hand = this.#onHand();
    const low = this.#ingredients.filter(i => (hand[i.id] || 0) < i.parLevel).length;
    this.#stock.push({ timestamp: this.now().toISOString(), totalQty: Object.values(hand).reduce((a, b) => a + b, 0), lowCount: low });
    if (this.#stock.length > 5000) this.#stock.shift();
  }
  receive({ lotId, ingredientId, qty }) {
    if (this.#lots.has(lotId)) fail('ConflictError', 'Lot ID was already received');
    if (!this.#ingredients.some(i => i.id === ingredientId)) fail('LookupError', 'Ingredient is missing or disabled');
    if (!Number.isInteger(qty) || qty < 1) fail('ValueError', 'Invalid qty');
    const now = this.now().toISOString();
    const lot = { id: lotId, ingredientId, qty, receivedAt: now, active: true, simulated: false };
    this.#lots.set(lotId, lot);
    this.#movements.push({ id: `${lotId}_receive`, timestamp: now, type: 'receive', ingredientId, lotId, qty });
    this.#recordStock();
    return { lot: structuredClone(lot), replayed: false, warnings: [] };
  }
  consume({ lotId, qty, kind = 'consume' }) {
    const lot = this.#lots.get(lotId);
    if (!lot) fail('LookupError', 'Lot not found');
    if (!lot.active || lot.qty <= 0) return { lot: structuredClone({ ...lot, qty: 0 }), replayed: true, warnings: [] };
    if (qty > lot.qty) fail('ConflictError', 'Not enough stock in this lot');
    lot.qty -= qty;
    if (lot.qty === 0) lot.active = false;
    const now = this.now().toISOString();
    this.#movements.push({ id: `${lotId}_${kind}_${now}`, timestamp: now, type: kind, ingredientId: lot.ingredientId, lotId, qty });
    this.#recordStock();
    return { lot: structuredClone(lot), replayed: false, warnings: [] };
  }
  async close() {}
}
void ZONES;
