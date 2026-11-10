# Restaurant Kitchen Operations Monitor (draft)

Tracks kitchen stations, live tickets, completions, and backlog history on GridDB Native + Node.js.

Stations: 12 across Grill (G), Fry (F), Pass (P). Tickets are fired to a station and completed when the dish leaves the pass. A simulator generates one fire/complete event every 5 seconds (stopped by default).

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
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
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

Browser dashboard is a React app (Vite + Tailwind CSS + shadcn-style components in `dashboard/src/components/ui`). The workspace commands build it to `dashboard/dist`, which the Node API serves. The API server itself still uses only built-in Node modules.

## Quick preview without GridDB

Node.js 22+ required. From this folder:

```bash
cd apps
npm install
npm run dev:demo
```

Open **http://127.0.0.1:3003**. The header says `DEMO · memory only`. Demo starts with a few active tickets and resets when the server stops.

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

`doctor` checks local prerequisites. `init` creates containers and refuses incompatible schemas. `seed` adds missing station metadata without clearing tickets. `dev:live` refuses to start if the database is unreachable or no stations exist.

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

All names start with `KITCHEN_CONTAINER_PREFIX`. Ticket containers are unchanged from the draft; inventory adds:

| Suffix | Container | Key | Purpose |
| --- | --- | --- | --- |
| `stations` | Collection | `station_id` | Zone, station type, enabled state |
| `tickets` | Collection | UUID `ticket_id` | Dish, station, fired/completed timestamps, active state, simulated flag |
| `events` | Collection | `ticket_id` + event type | Timestamped fired/completed audit projection |
| `backlog` | TimeSeries | Timestamp | Active ticket count and capacity |
| `sensor_G01` … | TimeSeries | Timestamp | Per-station busy state, ticket ID, source |
| `ingredients` | Collection | `ingredient_id` | Name, unit, par level, enabled state |
| `lots` | Collection | UUID `lot_id` | Ingredient, qty, received/expiry timestamps, active state |
| `movements` | Collection | `lot_id` + type | Receive/consume/waste audit projection |
| `stock` | TimeSeries | Timestamp | Total qty on hand and low-ingredient count |

Tickets are authoritative. Event/backlog projections are best-effort; on projection failure the API returns the saved ticket plus a warning.

## API reference

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Real native DB check; demo reports no database |
| GET | `/api/kitchen` | Stations, active tickets, summary, simulator state |
| GET | `/api/events` | Newest 100 events |
| GET | `/api/history?hours=24` | Newest 1,000 backlog samples, 1–168h window |
| POST | `/api/tickets/fire` | Fire a ticket: `{ticketId, stationId, dishTag}` |
| POST | `/api/tickets/complete` | Complete a ticket: `{ticketId}` |
| GET | `/api/inventory` | Ingredients with on-hand qty and low flags |
| GET | `/api/movements` | Newest 100 receive/consume/waste movements |
| GET | `/api/stock-history?hours=24` | Stock-level history, 1–168h window |
| POST | `/api/inventory/receive` | Receive a lot: `{lotId, ingredientId, qty, expiresInDays?}` |
| POST | `/api/inventory/consume` | Consume/waste: `{lotId, qty, kind?}` |
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

Matching retries return the same ticket. Conflicting station/dish returns 409; bad input 400; missing ticket 404; native failures 503.

## Verification

```bash
cd apps
npm run check
npm test
```

Offline checks only; they do not prove a live GridDB Cloud connection.
