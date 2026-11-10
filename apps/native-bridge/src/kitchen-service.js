const STATIONS = [];
for (const [zone, type] of [['Grill', 'grill'], ['Fry', 'fry'], ['Pass', 'pass']]) {
  const prefix = zone[0].toUpperCase();
  for (let n = 1; n <= 4; n++) STATIONS.push(`${prefix}0${n}`);
}
const STATION_RE = /^(G0[1-4]|F0[1-4]|P0[1-4])$/;

function invalid(message) { throw Object.assign(new Error(message), { name: 'ValueError' }); }
export function firePayload(body) {
  const ticketId = body.ticketId;
  const stationId = body.stationId;
  const dishTag = typeof body.dishTag === 'string' ? body.dishTag.trim().toUpperCase() : '';
  if (typeof ticketId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId)) invalid('Provide a UUID ticketId so retries are idempotent');
  if (typeof stationId !== 'string' || !STATION_RE.test(stationId)) invalid('Invalid kitchen station');
  if (!/^[A-Z0-9 -]{1,16}$/.test(dishTag)) invalid('Dish tag must contain 1–16 letters, digits, spaces or hyphens');
  return { ticketId: ticketId.toLowerCase(), stationId, dishTag };
}
export function completePayload(body) {
  if (typeof body.ticketId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.ticketId)) invalid('Invalid ticketId');
  return { ticketId: body.ticketId.toLowerCase() };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function receivePayload(body) {
  if (typeof body.lotId !== 'string' || !UUID_RE.test(body.lotId)) invalid('Provide a UUID lotId so receives are idempotent');
  if (typeof body.ingredientId !== 'string' || !/^[A-Z]{2,12}$/.test(body.ingredientId)) invalid('Invalid ingredient');
  if (!Number.isInteger(body.qty) || body.qty < 1 || body.qty > 100000) invalid('qty must be an integer from 1 to 100000');
  const expiresInDays = body.expiresInDays ?? 7;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) invalid('expiresInDays must be an integer from 1 to 365');
  return { lotId: body.lotId.toLowerCase(), ingredientId: body.ingredientId, qty: body.qty, expiresInDays };
}
export function consumePayload(body) {
  if (typeof body.lotId !== 'string' || !UUID_RE.test(body.lotId)) invalid('Invalid lotId');
  if (!Number.isInteger(body.qty) || body.qty < 1 || body.qty > 100000) invalid('qty must be an integer from 1 to 100000');
  const kind = body.kind ?? 'consume';
  if (kind !== 'consume' && kind !== 'waste') invalid('kind must be consume or waste');
  return { lotId: body.lotId.toLowerCase(), qty: body.qty, kind };
}
export class KitchenService {
  #timer;
  #busy = false;
  #lastError = null;
  #lastWarnings = [];
  constructor(store) { this.store = store; }
  get simulator() { return { running: Boolean(this.#timer), busy: this.#busy, lastError: this.#lastError, warnings: this.#lastWarnings }; }
  async snapshot() { return { ...await this.store.request('snapshot'), simulator: this.simulator }; }
  async fire(body) { return this.store.request('fire', firePayload(body)); }
  async complete(body) { return this.store.request('complete', completePayload(body)); }
  async history(hours) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) invalid('hours must be an integer from 1 to 168');
    return this.store.request('history', { hours });
  }
  async inventory() { return this.store.request('inventory'); }
  async receive(body) { return this.store.request('receive', receivePayload(body)); }
  async consume(body) { return this.store.request('consume', consumePayload(body)); }
  async movements() { return this.store.request('movements'); }
  async stockHistory(hours) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) invalid('hours must be an integer from 1 to 168');
    return this.store.request('stock_history', { hours });
  }
  startSimulator() {
    if (this.#timer) return this.simulator;
    this.#lastError = null;
    this.#timer = setInterval(async () => {
      if (this.#busy) return;
      this.#busy = true;
      try {
        const result = await this.store.request('simulate');
        this.#lastWarnings = result.warnings || [];
      } catch (error) {
        this.#lastError = error.message;
        this.stopSimulator();
      } finally { this.#busy = false; }
    }, 5000);
    return this.simulator;
  }
  stopSimulator() { clearInterval(this.#timer); this.#timer = null; return this.simulator; }
  async close() { this.stopSimulator(); await this.store.close(); }
}
