import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GridDBClient } from './griddb-client.js';
import { DemoStore } from './demo-store.js';
import { KitchenService } from './kitchen-service.js';

const dashboardDist = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function serveDashboard(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  if (relative.startsWith('..')) return false;
  try {
    const data = await readFile(join(dashboardDist, relative));
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(relative)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
const statuses = { ValueError: 400, ConflictError: 409, LookupError: 404 };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Provide a JSON object'), { name: 'ValueError' }); }
}
function normalizeTicket(input) {
  return { ticketId: input.ticketId, stationId: input.stationId, dishTag: input.dishTag };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function isAllowedOrigin(originHeader, configuredOrigin) {
  if (!originHeader) return true;
  if (originHeader === configuredOrigin) return true;
  try {
    const originUrl = new URL(originHeader);
    const configuredUrl = new URL(configuredOrigin);
    // Loopback aliases (localhost vs 127.0.0.1) and the Vite dev port are the same local user.
    return LOOPBACK_HOSTS.has(originUrl.hostname) && LOOPBACK_HOSTS.has(configuredUrl.hostname);
  } catch {
    return false;
  }
}

export function createKitchenServer(store, { origin = 'http://127.0.0.1:3003' } = {}) {
  const service = new KitchenService(store);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveDashboard(url.pathname, res)) return;
      }
      if (req.method === 'POST') {
        if (!isAllowedOrigin(req.headers.origin, origin)) {
          json(res, 403, { error: 'Cross-origin writes are disabled' }); return;
        }
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          json(res, 415, { error: 'Use application/json' }); return;
        }
      }
      let result;
      let status = 200;
      if (req.method === 'GET' && url.pathname === '/api/health') result = await store.request('health');
      else if (req.method === 'GET' && url.pathname === '/api/kitchen') result = await service.snapshot();
      else if (req.method === 'GET' && url.pathname === '/api/events') result = await store.request('events');
      else if (req.method === 'GET' && url.pathname === '/api/history') result = await service.history(Number(url.searchParams.get('hours') ?? 24));
      else if (req.method === 'GET' && url.pathname === '/api/inventory') result = await service.inventory();
      else if (req.method === 'GET' && url.pathname === '/api/movements') result = await service.movements();
      else if (req.method === 'GET' && url.pathname === '/api/stock-history') result = await service.stockHistory(Number(url.searchParams.get('hours') ?? 24));
      else if (req.method === 'POST' && url.pathname === '/api/inventory/receive') result = await service.receive(await body(req));
      else if (req.method === 'POST' && url.pathname === '/api/inventory/consume') result = await service.consume(await body(req));
      else if (req.method === 'POST' && url.pathname === '/api/tickets/fire') {
        const n = normalizeTicket(await body(req));
        result = await service.fire({ ticketId: n.ticketId, stationId: n.stationId, dishTag: n.dishTag }); status = result.replayed ? 200 : 201;
      } else if (req.method === 'POST' && url.pathname === '/api/tickets/complete') {
        const raw = await body(req);
        const id = raw.ticketId;
        result = await service.complete({ ticketId: id });
      }
      else if (req.method === 'POST' && url.pathname === '/api/simulator/start') { await body(req); result = service.startSimulator(); }
      else if (req.method === 'POST' && url.pathname === '/api/simulator/stop') { await body(req); result = service.stopSimulator(); }
      else { json(res, 404, { error: 'Endpoint not found' }); return; }
      json(res, status, result);
    } catch (error) {
      const status = error.status || statuses[error.name] || 503;
      json(res, status, { error: error.message });
    }
  });
  return { server, service };
}

export async function main() {
  const mode = process.env.KITCHEN_MODE || 'native';
  if (!['native', 'demo'].includes(mode)) throw new Error('KITCHEN_MODE must be native or demo');
  const host = process.env.KITCHEN_API_HOST || '127.0.0.1';
  const port = Number(process.env.KITCHEN_API_PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port');
  const store = mode === 'demo' ? new DemoStore({}) : new GridDBClient();
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const { server, service } = createKitchenServer(store, { origin });
  try {
    await store.request('health');
    const initial = await service.snapshot();
    if (!initial.stats.capacity) throw new Error('No kitchen stations found; run npm run seed');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { await service.close(); throw error; }
  console.log(`Kitchen Operations: ${origin} (${mode === 'demo' ? 'DEMO — in-memory, no GridDB' : 'GridDB native'})`);
  console.log('Simulator is stopped. Start it explicitly from the dashboard.');
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    service.stopSimulator();
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => process.exit(1), 3000);
    timer.unref();
    await service.close();
    server.closeAllConnections();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
