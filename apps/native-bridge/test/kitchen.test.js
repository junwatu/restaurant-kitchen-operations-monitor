import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoStore } from '../src/demo-store.js';
import { isAllowedOrigin } from '../src/server.js';
import { firePayload, completePayload, receivePayload, consumePayload } from '../src/kitchen-service.js';
import { createKitchenServer } from '../src/server.js';

test('fire payload validation', () => {
  const id = '5b5207cb-92ab-491e-b410-132535258ba1';
  assert.deepEqual(firePayload({ ticketId: id, stationId: 'G01', dishTag: 'burger-02' }), { ticketId: id, stationId: 'G01', dishTag: 'BURGER-02' });
  assert.throws(() => firePayload({ ticketId: 'nope', stationId: 'G01', dishTag: 'X' }), /UUID/);
  assert.throws(() => firePayload({ ticketId: id, stationId: 'Z99', dishTag: 'X' }), /station/);
  assert.deepEqual(completePayload({ ticketId: id }), { ticketId: id });
});

test('fire is idempotent and station conflicts return 409 names', async () => {
  const store = new DemoStore({ now: () => new Date('2026-01-01T12:00:00Z') });
  const id = '5b5207cb-92ab-491e-b410-132535258ba1';
  const first = await store.request('fire', { ticketId: id, stationId: 'G01', dishTag: 'RAMEN' });
  assert.equal(first.replayed, false);
  const replay = await store.request('fire', { ticketId: id, stationId: 'G01', dishTag: 'RAMEN' });
  assert.equal(replay.replayed, true);
  await assert.rejects(store.request('fire', { ticketId: '6b5207cb-92ab-491e-b410-132535258ba2', stationId: 'G01', dishTag: 'RAMEN' }), /already busy/);
});

test('complete closes ticket and replays', async () => {
  const store = new DemoStore({ now: () => new Date('2026-01-01T12:00:00Z') });
  const id = '5b5207cb-92ab-491e-b410-132535258ba1';
  await store.request('fire', { ticketId: id, stationId: 'G01', dishTag: 'FRIES' });
  const done = await store.request('complete', { ticketId: id });
  assert.equal(done.session.active, false);
  const replay = await store.request('complete', { ticketId: id });
  assert.equal(replay.replayed, true);
  await assert.rejects(store.request('complete', { ticketId: '00000000-0000-4000-8000-000000000000' }), /not found/);
});

test('inventory receive/consume flow with same CRUD errors', async () => {
  const store = new DemoStore({ now: () => new Date('2026-01-01T12:00:00Z') });
  const inv = await store.request('inventory');
  assert.equal(inv.items.length, 6);
  assert.ok(inv.lowCount >= 1);
  const lotId = '7b5207cb-92ab-491e-b410-132535258ba1';
  const received = await store.request('receive', { lotId, ingredientId: 'TOMATO', qty: 25 });
  assert.equal(received.replayed, false);
  await assert.rejects(store.request('receive', { lotId, ingredientId: 'TOMATO', qty: 25 }), /already received/);
  const used = await store.request('consume', { lotId, qty: 5, kind: 'consume' });
  assert.equal(used.lot.qty, 20);
  await assert.rejects(store.request('consume', { lotId, qty: 999999 }), /Not enough stock/);
  const moves = await store.request('movements');
  assert.ok(moves.length >= 2);
  const stock = await store.request('stock_history', { hours: 24 });
  assert.ok(Array.isArray(stock.points));
  assert.deepEqual(receivePayload({ lotId, ingredientId: 'TOMATO', qty: 1 }), { lotId, ingredientId: 'TOMATO', qty: 1, expiresInDays: 7 });
  assert.throws(() => consumePayload({ lotId, qty: 1, kind: 'eat' }), /kind/);
  await store.close();
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

test('snapshot, events and history shape', async () => {
  const store = new DemoStore({ now: () => new Date('2026-01-01T12:00:00Z') });
  const kitchen = await store.request('snapshot');
  assert.equal(kitchen.stats.capacity, 12);
  assert.equal(kitchen.spaces.length, 12);
  const events = await store.request('events');
  assert.ok(Array.isArray(events));
  const history = await store.request('history', { hours: 24 });
  assert.ok(Array.isArray(history.points));
  await store.close();
  void createKitchenServer;
});
