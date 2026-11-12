import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoStore } from '../src/demo-store.js';
import { firePayload, completePayload, receivePayload, consumePayload } from '../src/kitchen-service.js';
import { createKitchenServer, isAllowedOrigin } from '../src/server.js';

const NOW = () => new Date('2026-01-01T12:00:00Z');
const T1 = '5b5207cb-92ab-491e-b410-132535258ba1';
const T2 = '6b5207cb-92ab-491e-b410-132535258ba2';
const LOT = '7b5207cb-92ab-491e-b410-132535258ba1';
const C1 = '8b5207cb-92ab-491e-b410-132535258ba1';
const C2 = '9b5207cb-92ab-491e-b410-132535258ba2';

test('payload validation', () => {
  assert.deepEqual(firePayload({ ticketId: T1, stationId: 'G01', dishTag: 'burger-02' }), { ticketId: T1, stationId: 'G01', dishTag: 'BURGER-02' });
  assert.throws(() => firePayload({ ticketId: 'nope', stationId: 'G01', dishTag: 'X' }), /UUID/);
  assert.throws(() => firePayload({ ticketId: T1, stationId: 'Z99', dishTag: 'X' }), /station/);
  assert.deepEqual(completePayload({ ticketId: T1 }), { ticketId: T1 });
  assert.deepEqual(receivePayload({ lotId: LOT, ingredientId: 'TOMATO', qty: 1 }), { lotId: LOT, ingredientId: 'TOMATO', qty: 1, expiresInDays: 7 });
  assert.deepEqual(consumePayload({ consumeId: C1, lotId: LOT, qty: 1 }), { consumeId: C1, lotId: LOT, qty: 1, kind: 'consume' });
  assert.throws(() => consumePayload({ lotId: LOT, qty: 1 }), /consumeId/);
  assert.throws(() => consumePayload({ consumeId: C1, lotId: LOT, qty: 1, kind: 'eat' }), /kind/);
});

test('fire is idempotent and busy stations conflict', async () => {
  const store = new DemoStore({ now: NOW });
  const first = await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'RAMEN' });
  assert.equal(first.replayed, false);
  assert.equal(first.ticket.stationId, 'G01');
  assert.equal(first.ticket.completedAt, null);
  assert.equal((await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'RAMEN' })).replayed, true);
  await assert.rejects(store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'PASTA' }), /different order/);
  await assert.rejects(store.request('fire', { ticketId: T2, stationId: 'G01', dishTag: 'RAMEN' }), /already busy/);
});

test('complete closes a ticket and replays', async () => {
  const store = new DemoStore({ now: NOW });
  await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'FRIES' });
  const done = await store.request('complete', { ticketId: T1 });
  assert.equal(done.ticket.active, false);
  assert.equal(done.ticket.completedAt, NOW().toISOString());
  assert.equal((await store.request('complete', { ticketId: T1 })).replayed, true);
  await assert.rejects(store.request('complete', { ticketId: '00000000-0000-4000-8000-000000000000' }), /not found/);
});

test('receive replays the same delivery and rejects a different one', async () => {
  const store = new DemoStore({ now: NOW });
  const received = await store.request('receive', { lotId: LOT, ingredientId: 'TOMATO', qty: 25 });
  assert.equal(received.replayed, false);
  assert.equal(received.lot.expiresAt, '2026-01-08T12:00:00.000Z');
  assert.equal((await store.request('receive', { lotId: LOT, ingredientId: 'TOMATO', qty: 25 })).replayed, true);
  await assert.rejects(store.request('receive', { lotId: LOT, ingredientId: 'TOMATO', qty: 30 }), /different delivery/);
  await assert.rejects(store.request('receive', { lotId: LOT, ingredientId: 'CHEESE', qty: 25 }), /different delivery/);
});

test('consume is idempotent per consumeId and empty lots conflict', async () => {
  const store = new DemoStore({ now: NOW });
  await store.request('receive', { lotId: LOT, ingredientId: 'TOMATO', qty: 25 });
  assert.equal((await store.request('consume', { consumeId: C1, lotId: LOT, qty: 5, kind: 'consume' })).lot.qty, 20);
  const retry = await store.request('consume', { consumeId: C1, lotId: LOT, qty: 5, kind: 'consume' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.lot.qty, 20, 'a retry must not decrement twice');
  await assert.rejects(store.request('consume', { consumeId: C1, lotId: LOT, qty: 6, kind: 'consume' }), /different movement/);
  await assert.rejects(store.request('consume', { consumeId: C2, lotId: LOT, qty: 999 }), /Not enough stock/);
  assert.equal((await store.request('consume', { consumeId: C2, lotId: LOT, qty: 20, kind: 'waste' })).lot.active, false);
  await assert.rejects(store.request('consume', { consumeId: '00000000-0000-4000-8000-000000000001', lotId: LOT, qty: 1 }), /Lot is empty/);
  const moves = await store.request('movements');
  assert.deepEqual(moves.slice(0, 3).map(m => m.type), ['waste', 'consume', 'receive']);
});

test('completing a dish uses its recipe from the first-expiring lot, once', async () => {
  const store = new DemoStore({ now: NOW });
  const onHand = async id => (await store.request('inventory')).items.find(i => i.id === id).onHand;
  // A short-dated tomato lot (2 days) must be used before the seeded 7-day lot.
  await store.request('receive', { lotId: LOT, ingredientId: 'TOMATO', qty: 1, expiresInDays: 2 });
  const [tomato, cheese] = [await onHand('TOMATO'), await onHand('CHEESE')];
  await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'BURGER-12' });
  const done = await store.request('complete', { ticketId: T1 });
  assert.deepEqual(done.consumed, [{ ingredientId: 'CHEESE', qty: 1 }, { ingredientId: 'TOMATO', qty: 1 }]);
  assert.deepEqual(done.warnings, []);
  assert.equal(await onHand('TOMATO'), tomato - 1);
  assert.equal(await onHand('CHEESE'), cheese - 1);
  const moves = await store.request('movements');
  const tomatoMove = moves.find(m => m.id === `${T1}_TOMATO_${LOT}`);
  assert.equal(tomatoMove?.type, 'consume', 'tomato came from the short-dated lot');
  // A completion retry replays without consuming again.
  const retry = await store.request('complete', { ticketId: T1 });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.consumed, []);
  assert.equal(await onHand('TOMATO'), tomato - 1);
});

test('a shortfall is a warning and dishes without a recipe consume nothing', async () => {
  const store = new DemoStore({ now: NOW });
  const oilLot = (await store.request('movements')).find(m => m.ingredientId === 'OIL').lotId;
  await store.request('consume', { consumeId: C1, lotId: oilLot, qty: 12, kind: 'waste' });
  await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'FRIES-01' });
  const done = await store.request('complete', { ticketId: T1 });
  assert.equal(done.ticket.active, false, 'the dish still completes');
  assert.deepEqual(done.consumed, []);
  assert.match(done.warnings[0], /Not enough Oil for FRIES-01: short by 1/);
  const before = (await store.request('inventory')).items;
  const seeded = (await store.request('snapshot')).tickets.find(t => t.dishTag.startsWith('DISH-'));
  const plain = await store.request('complete', { ticketId: seeded.id });
  assert.deepEqual(plain.consumed, []);
  assert.deepEqual((await store.request('inventory')).items, before);
});

test('snapshot, inventory, events and history shapes', async () => {
  const store = new DemoStore({ now: NOW });
  const kitchen = await store.request('snapshot');
  assert.equal(kitchen.stats.capacity, 12);
  assert.equal(kitchen.stations.length, 12);
  assert.equal(kitchen.stats.busy, 3);
  assert.deepEqual(Object.keys(kitchen.stats).sort(), ['busy', 'capacity', 'completedToday', 'completedTodayTruncated', 'free', 'loadPercent']);
  assert.deepEqual(Object.keys(kitchen.tickets[0]).sort(), ['active', 'completedAt', 'dishTag', 'firedAt', 'id', 'simulated', 'stationId']);
  const inv = await store.request('inventory');
  assert.equal(inv.items.length, 6);
  assert.deepEqual(inv.items.filter(i => i.low).map(i => i.id), ['TOMATO', 'CHICKEN']);
  await store.request('fire', { ticketId: T1, stationId: 'G01', dishTag: 'RAMEN' });
  assert.deepEqual(Object.keys((await store.request('events'))[0]).sort(), ['dishTag', 'id', 'stationId', 'ticketId', 'timestamp', 'type']);
  const history = await store.request('history', { hours: 24 });
  assert.equal(history.points.at(-1).busy, 4);
  assert.ok(Array.isArray((await store.request('stock_history', { hours: 24 })).points));
});

test('loopback origin aliases are allowed, external origins are not', () => {
  const configured = 'http://127.0.0.1:3003';
  assert.equal(isAllowedOrigin(undefined, configured), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3003', configured), true);
  assert.equal(isAllowedOrigin('http://localhost:3003', configured), true);
  assert.equal(isAllowedOrigin('http://localhost:5173', configured), true);
  assert.equal(isAllowedOrigin('https://evil.example.com', configured), false);
  assert.equal(isAllowedOrigin('http://192.168.1.10:3003', configured), false);
});

test('HTTP status codes', async t => {
  const { server, service } = createKitchenServer(new DemoStore({ now: NOW }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, payload, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });

  assert.equal((await post('/api/tickets/fire', { ticketId: T1, stationId: 'G01', dishTag: 'RAMEN' })).status, 201);
  assert.equal((await post('/api/tickets/fire', { ticketId: T1, stationId: 'G01', dishTag: 'RAMEN' })).status, 200);
  assert.equal((await post('/api/tickets/fire', { ticketId: T2, stationId: 'G01', dishTag: 'RAMEN' })).status, 409);
  assert.equal((await post('/api/tickets/fire', { ticketId: 'x', stationId: 'G01', dishTag: 'RAMEN' })).status, 400);
  assert.equal((await post('/api/tickets/complete', { ticketId: T1 })).status, 200);
  assert.equal((await post('/api/tickets/complete', { ticketId: T2 })).status, 404);
  assert.equal((await post('/api/inventory/receive', { lotId: LOT, ingredientId: 'OIL', qty: 4 })).status, 201);
  assert.equal((await post('/api/inventory/receive', { lotId: LOT, ingredientId: 'OIL', qty: 4 })).status, 200);
  assert.equal((await post('/api/inventory/consume', { consumeId: C1, lotId: LOT, qty: 1 })).status, 201);
  assert.equal((await post('/api/inventory/consume', { consumeId: C1, lotId: LOT, qty: 1 })).status, 200);
  assert.equal((await post('/api/tickets/fire', {}, { Origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await fetch(`${base}/api/tickets/fire`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/history?hours=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
