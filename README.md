# Restaurant Kitchen Operations Monitor

A live kitchen dashboard that shows which cooking stations are busy and which ingredients are running low. It uses a React dashboard and a Node.js server, and stores orders, stock, and their history in GridDB Cloud through GridDB's native client.

## Project structure

```text
restaurant-kitchen-operations-monitor/
├── README.md
├── .gitignore
├── apps/
│   ├── package.json
│   ├── scripts/
│   │   ├── run.mjs
│   │   ├── doctor.mjs
│   │   └── check.mjs
│   ├── dashboard/
│   │   ├── package.json
│   │   ├── vite.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.jsx
│   │       ├── App.jsx
│   │       ├── index.css
│   │       ├── lib/utils.js
│   │       └── components/ui/  (alert, badge, button, card, input, table)
│   └── native-bridge/
│       ├── package.json
│       ├── .env.example
│       ├── lib/README.md
│       ├── scripts/setup-macos.sh
│       ├── scripts/install-cloud-jar.sh
│       ├── src/
│       │   ├── griddb-client.js
│       │   ├── kitchen-service.js
│       │   ├── demo-store.js
│       │   ├── server.js
│       │   └── index.js
│       ├── python/
│       │   ├── griddb_worker.py
│       │   ├── kitchen.py
│       │   └── init_schema.py
│       └── test/kitchen.test.js
└── blogs/restaurant-kitchen-operations-monitor/
    ├── blog.md
    └── assets/README.md
```

Browser dashboard is a React app (Vite + Tailwind CSS + shadcn-style components in `dashboard/src/components/ui`). It shows a one-line summary, then two boards side by side: the kitchen (station board with per-ticket timers, a fire form whose dish buttons fill a tag like `RAMEN-37`, and the active ticket list) and inventory (ingredient levels against par and a receive form). Light mode by default; the header moon button switches to dark. Consume/waste, history, events, movements and stock history are API-only. The workspace commands build it to `dashboard/dist`, which the Node API serves. The API server itself still uses only built-in Node modules.

## Quick preview without GridDB

Node.js 22+ required. From this folder:

```bash
cd apps
npm install
npm run dev:demo
```

Open **http://127.0.0.1:3003**. The header says `Demo · memory only`. Demo starts with a few active tickets and resets when the server stops.

## Native GridDB Cloud setup (macOS)

Requirements: Node.js 22+, Python 3.12, Homebrew, Java 21, Maven, GridDB Cloud with a public native route.

```bash
cd apps
npm install
npm run setup:mac
cp native-bridge/.env.example native-bridge/.env
```

In your Cloud portal generate the Notification Provider URL, allowlist the app's public outbound IP, and download the compatible Cloud Java library. Install it with:

```bash
npm run install:cloud-jar -- /path/to/griddb-ee-java-lib-5.9.0-linux.x86_64.rpm
```

Edit `native-bridge/.env` (see `.env.example`). Use a dedicated database or prefix. Prefix must start with a letter, max 41 chars: letters, digits, underscores.

```bash
npm run doctor
npm run init
npm run seed
npm run dev:griddb
npm run dev:live
```

`doctor` checks local prerequisites. `init` creates containers and refuses incompatible schemas. `seed` adds missing stations and ingredients without clearing tickets or lots. `dev:griddb` makes one real request to confirm the connection. `dev:live` refuses to start if the database is unreachable or no stations exist.

A timeout on `init` or `dev:griddb` usually means your IP is not on the GridDB Cloud access list. A live database starts with no stock (seed creates no lots), so receive a delivery for each ingredient with **+N** before completing dishes, or each completion warns that stock is short.

## How the native bridge works

```text
Browser dashboard
  → local Node.js HTTP API
  → persistent Python worker over NDJSON stdin/stdout
  → JPype / JVM / GridDB Java client
  → GridDB native connection to GridDB Cloud
```

One worker owns the store and serializes all kitchen operations.

## How inventory fits the ticket model

Both domains run on the same native CRUD bridge (`put`/`get`/`query` through the persistent Python worker). Stock-in creates a lot + movement + stock sample; consume/waste decrements the lot and appends the next movement. Low-stock state is derived from lot totals vs par levels, exactly like station availability is derived from active tickets.

## Schema and data ownership

All names start with `KITCHEN_CONTAINER_PREFIX`.

| Suffix | Container | Key | Purpose |
| --- | --- | --- | --- |
| `stations` | Collection | `station_id` | Zone, station type, enabled state |
| `tickets` | Collection | UUID `ticket_id` | Dish, station, fired/completed timestamps, active state, simulated flag |
| `events` | Collection | `ticket_id` + event type | Timestamped fired/completed audit projection |
| `backlog` | TimeSeries | Timestamp | Active ticket count and capacity |
| `sensor_G01` … | TimeSeries | Timestamp | Per-station busy state, ticket ID, source |
| `ingredients` | Collection | `ingredient_id` | Name, unit, par level, enabled state |
| `lots` | Collection | UUID `lot_id` | Ingredient, qty, received/expiry timestamps, active state |
| `movements` | Collection | `<lotId>_receive`, `<ticketId>_<ingredientId>_<lotId>`, or `consumeId` | Receive/consume/waste audit projection; also the consume retry record |
| `stock` | TimeSeries | Timestamp | Total qty on hand and low-ingredient count |

Tickets and lots are authoritative. Event, backlog, sensor, movement, and stock projections are best-effort; on projection failure the API returns the saved row plus a warning.

Every column, with its type and meaning: [docs/data-model.md](docs/data-model.md).

## API reference

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Real native DB check; demo reports no database |
| GET | `/api/kitchen` | Stations, active tickets, summary, simulator state |
| GET | `/api/events` | Newest 100 events |
| GET | `/api/history?hours=24` | Newest 1,000 backlog samples, 1–168h window |
| POST | `/api/tickets/fire` | Fire a ticket: `{ticketId, stationId, dishTag}` |
| POST | `/api/tickets/complete` | Complete a ticket and use its recipe's ingredients (first-expiring lots first): `{ticketId}` |
| GET | `/api/inventory` | Ingredients with on-hand qty and low flags |
| GET | `/api/movements` | Newest 100 receive/consume/waste movements |
| GET | `/api/stock-history?hours=24` | Stock-level history, 1–168h window |
| POST | `/api/inventory/receive` | Receive a lot: `{lotId, ingredientId, qty, expiresInDays?}` |
| POST | `/api/inventory/consume` | Consume/waste: `{consumeId, lotId, qty, kind?}` |
| POST | `/api/simulator/start` | Start simulation; send `{}` |
| POST | `/api/simulator/stop` | Stop simulation; send `{}` |

```bash
curl -X POST http://127.0.0.1:3003/api/tickets/fire \
  -H 'Content-Type: application/json' \
  -d '{"ticketId":"5b5207cb-92ab-491e-b410-132535258ba1","stationId":"G01","dishTag":"BURGER-02"}'
curl -X POST http://127.0.0.1:3003/api/tickets/complete \
  -H 'Content-Type: application/json' \
  -d '{"ticketId":"5b5207cb-92ab-491e-b410-132535258ba1"}'
```

Fire, receive, and consume take caller-generated UUIDs (`ticketId`, `lotId`, `consumeId`). The first call returns 201; a matching retry returns 200 with `replayed: true`; the same ID with a different payload returns 409. Busy station, empty lot, or not enough stock also return 409; bad input 400; missing ticket/lot 404; native failures 503.

## Verification

```bash
cd apps
npm run check
npm test
```

Offline checks only. Tests run against the in-memory demo store (which mirrors `python/kitchen.py`) and the real HTTP server; they do not prove a live GridDB Cloud connection.
