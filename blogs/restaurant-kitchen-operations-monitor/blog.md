# Building a Restaurant Kitchen Monitor with GridDB Native and Node.js

A kitchen pass needs to answer two practical questions at once: which stations are free right now, and do we have the ingredients to keep them firing? This tutorial builds a small kitchen operations app with Node.js and GridDB Native. It tracks 12 stations, live tickets, and an ingredient inventory with lots, movements, and low-stock alerts.

## Table of Contents

- [Background](#background)
- [Scope and Features](#scope-and-features)
- [Client Selection Rationale](#client-selection-rationale)
- [Requirements](#requirements)
- [Installation and Startup](#installation-and-startup)
- [Runtime Design](#runtime-design)
- [Data Model](#data-model)
- [Bridge Internals and API Surface](#bridge-internals-and-api-surface)
- [Order and Inventory Lifecycles](#order-and-inventory-lifecycles)
- [Load Simulation](#load-simulation)
- [Query Patterns and Examples](#query-patterns-and-examples)
- [Verification](#verification)
- [Production Integration](#production-integration)
- [Future Work](#future-work)
- [Summary](#summary)
- [Related Documentation](#related-documentation)

## Background

A ticket board alone tells you what was ordered. It does not tell you whether the kitchen can still cook it. This app pairs the familiar fire/complete ticket flow with ingredient lots: every receive creates a lot, every consume or waste decrements one, and on-hand totals are compared against par levels. The dashboard shows both boards side by side, so a low-stock ingredient reads the same way a busy station does.

## Scope and Features

- 12 stations across Grill (G01–G04), Fry (F01–F04), and Pass (P01–P04).
- Fire and complete tickets with caller-generated UUIDs, so retries are idempotent.
- Dashboard: a one-line summary, then a live station board with per-ticket timers, an active ticket list, ingredient levels against par, and a receive form.
- Ingredient inventory: 6 ingredients, receive/consume/waste lots, and low-stock flags.
- Completing a dish uses its recipe: each dish has a bill of materials, and completion draws those ingredients from the first-expiring lots.
- History through the API: ticket events, backlog samples, inventory movements, and stock levels.
- A simulator that generates one kitchen event every 5 seconds, stopped by default.

The application runs in two modes:

- Demo mode keeps tickets and inventory in memory for preview, with no database connection.
- Native (live) mode persists both to real GridDB containers.

## Client Selection Rationale

This tutorial uses the native GridDB client to create containers, write rows, and execute TQL queries against GridDB Cloud. Node.js serves the dashboard and HTTP API, while the Python client performs database operations through JPype and the GridDB Java client.

This is an architectural choice for this project; we haven't established that it is faster or universally better than the Web API.

### How It Works

A persistent Python worker connects the two runtimes. It keeps the JVM and database store alive across requests, avoiding the overhead of starting them for every operation.

```text
Browser → Node.js HTTP API → NDJSON over stdin/stdout
        → persistent Python worker → JPype/JVM
        → GridDB native connection → GridDB Cloud
```

The browser sends HTTP requests. Node.js sends JSON commands to Python, and Python performs database operations using the native GridDB client. These operations do not use the GridDB Cloud Web API. The Notification Provider URL uses HTTPS for discovery.

The worker handles operations serially. See the official [GridDB Python client](https://github.com/griddb/python_client) and [Cloud public native connection article](https://www.griddb.net/en/blog/connecting-to-griddb-cloud-v3-2-from-your-local-dev-environment-no-vpn-no-vnet-peering/) for the client architecture and route configuration.

## Requirements

### Node.js

Install Node.js 22 or newer. The API server uses built-in Node modules for the HTTP server and process bridge. The dashboard is a React application built with Vite, Tailwind CSS, and shadcn-style components; the workspace commands build it before starting the API, which serves the static output from `dashboard/dist`.

### Python

Python 3.12 is recommended. The macOS setup script installs the GridDB Python package, JPype, and PyArrow into the project virtual environment at `apps/native-bridge/.venv/`.

### Java and Maven

The GridDB Python client invokes the Java API through JPype. The included macOS setup script uses Homebrew to install OpenJDK 21 and Maven, then builds the Arrow adapter.

### GridDB Cloud

Use a GridDB Cloud service with a supported public native route. From the portal:

1. Generate the Notification Provider URL.
2. Add your application's public outbound IP to the GridDB access list.
3. Download the compatible Cloud Java library bundle and extract `gridstore-advanced.jar` into `apps/native-bridge/lib/`.

The setup script supplies the public libraries; it does not download the licensed Cloud JAR. Keep the JAR and real credentials outside a public repository.

## Installation and Startup

### 1. Preview without GridDB

```bash
cd apps
npm install
npm run dev:demo
```

Open `http://127.0.0.1:3003`. The header says `Demo · memory only`. Demo starts with three busy stations, six seeded ingredient lots (tomato and chicken already below par so the low-stock state is visible), and resets when the server stops.

To try it, tap a free station, pick a dish (the tag gets a random order number, such as `PASTA-26`), and press **Fire**. The tile shows a running timer that turns amber at 10 minutes and red at 20; press **Done** when the dish leaves. On the inventory side, **+N** next to a low ingredient prefills a delivery that brings it back to par.

### 2. Install the native dependencies (macOS)

```bash
npm run setup:mac
```

Then install the Cloud JAR:

```bash
npm run install:cloud-jar -- "/path/to/griddb-ee-java-lib-5.9.0-linux.x86_64.rpm"
```

The runtime directory should contain `gridstore.jar`, `gridstore-arrow.jar`, `arrow-memory-netty.jar`, and `gridstore-advanced.jar`.

### 3. Configure environment variables

```bash
cp native-bridge/.env.example native-bridge/.env
```

Fill in your provider URL, cluster, database, user, and password. Use a dedicated database or container prefix (`KITCHEN_CONTAINER_PREFIX`, default `kitchen_demo`). The prefix must start with a letter and contain at most 41 letters, digits, or underscores.

```bash
npm run doctor
npm run init
npm run seed
npm run dev:griddb
npm run dev:live
```

`doctor` checks local prerequisites. `init` creates the containers and refuses incompatible schemas without deleting data. `seed` adds missing stations and ingredients without clearing tickets or lots. `dev:live` refuses to start if the database is unreachable or no stations exist.

## Runtime Design

### Ticket and inventory input

Manual fires and receives are the basic input. An optional simulator attempts one kitchen transition every five seconds. Per-station busy flags and stock totals are derived from authoritative rows, giving a reproducible data stream without kitchen hardware.

### Node.js application

Node.js serves the browser dashboard and the kitchen APIs, validates inputs, starts the worker, matches NDJSON responses to pending requests, and controls the simulator timer. The server exposes named kitchen operations rather than accepting arbitrary TQL or container names from the browser.

### Python GridDB worker

One persistent Python process starts the JVM, loads the JARs, and creates the GridDB store. It executes ticket and inventory operations serially, converting native timestamps and serializing results as JSON.

### Kitchen and inventory logic

`python/kitchen.py` checks station availability, fires and completes tickets, receives and consumes lots, computes on-hand totals against par levels, and records event, movement, backlog, and stock projections. Tickets and lots stay authoritative; projections describe their history.

### GridDB Cloud

GridDB stores stations, tickets, ingredients, lots, movements, and history samples. Collections use stable string keys for business records. TimeSeries containers use timestamp keys for recent-window queries.

## Data Model

All container names begin with `KITCHEN_CONTAINER_PREFIX` (default `kitchen_demo`).

| Suffix | Type | Purpose |
| --- | --- | --- |
| `stations` | Collection | Station metadata (zone, type, enabled) |
| `tickets` | Collection | Authoritative tickets |
| `events` | Collection | Fired/completed audit projection |
| `backlog` | TimeSeries | Busy-station history |
| `sensor_<id>` | TimeSeries | Per-station busy projection |
| `ingredients` | Collection | Ingredient metadata, unit, par level |
| `lots` | Collection | Received lots with qty and expiry |
| `movements` | Collection | Receive/consume/waste audit projection |
| `stock` | TimeSeries | Total qty on hand and low-ingredient count |

### `stations` Collection

| Column | Type | Description |
| --- | --- | --- |
| `station_id` | STRING, row key | `G01`–`G04`, `F01`–`F04`, `P01`–`P04` |
| `zone` | STRING | `Grill`, `Fry`, or `Pass` |
| `station_type` | STRING | Lowercase zone name |
| `enabled` | BOOL | Disabled stations cannot take tickets |

### `tickets` Collection

| Column | Type | Description |
| --- | --- | --- |
| `ticket_id` | STRING, row key | Caller-generated UUID |
| `station_id` | STRING | Station reference |
| `dish_tag` | STRING | 1–16 uppercase letters, digits, spaces, or hyphens |
| `fired_at` | TIMESTAMP | Fire time in UTC |
| `completed_at` | TIMESTAMP | Equal to `fired_at` until the ticket is completed |
| `active` | BOOL | True until completed |
| `simulated` | BOOL | Whether the simulator created the ticket |

### `events` Collection

| Column | Type | Description |
| --- | --- | --- |
| `event_id` | STRING, row key | `<ticketId>_fired` or `<ticketId>_completed` |
| `timestamp` | TIMESTAMP | Event time in UTC |
| `event_type` | STRING | `fired` or `completed` |
| `station_id` | STRING | Station reference |
| `ticket_id` | STRING | Ticket reference |
| `dish_tag` | STRING | Copied from the ticket |

### `backlog` TimeSeries

| Column | Type | Description |
| --- | --- | --- |
| `timestamp` | TIMESTAMP, row key | Sample time in UTC |
| `busy` | INTEGER | Active tickets (busy stations) |
| `capacity` | INTEGER | Enabled stations |

### `sensor_<stationId>` TimeSeries

One container per station, written with every backlog sample.

| Column | Type | Description |
| --- | --- | --- |
| `timestamp` | TIMESTAMP, row key | Sample time in UTC |
| `busy` | BOOL | Whether the station has an active ticket |
| `ticket_id` | STRING | Active ticket, or empty when free |
| `source` | STRING | Always `ticket_projection` in this app |

### `ingredients` Collection

| Column | Type | Description |
| --- | --- | --- |
| `ingredient_id` | STRING, row key | e.g. `TOMATO`, `CHEESE` |
| `name` | STRING | Display name |
| `unit` | STRING | `kg`, `g`, or `L` |
| `par_level` | INTEGER | Reorder threshold in the same unit |
| `enabled` | BOOL | Whether the ingredient accepts receives |

Seeded with six ingredients: tomato, cheese, flour, chicken, basil, oil.

### `lots` Collection

| Column | Type | Description |
| --- | --- | --- |
| `lot_id` | STRING, row key | UUID for one delivery |
| `ingredient_id` | STRING | Ingredient reference |
| `qty` | INTEGER | Remaining quantity; decremented by consume/waste |
| `received_at` | TIMESTAMP | Receive time in UTC |
| `expires_at` | TIMESTAMP | Receive time plus `expiresInDays` (default 7) |
| `active` | BOOL | False once the lot hits zero |
| `simulated` | BOOL | Whether the simulator created the lot |

UUID keys let distinct deliveries share a timestamp. A lot at zero stays for audit and retry handling.

### `movements` Collection

| Column | Type | Description |
| --- | --- | --- |
| `movement_id` | STRING, row key | `<lotId>_receive` for receives; the caller's `consumeId` UUID for consume/waste |
| `timestamp` | TIMESTAMP | Movement time in UTC |
| `movement_type` | STRING | `receive`, `consume`, or `waste` |
| `ingredient_id` | STRING | Ingredient reference |
| `lot_id` | STRING | Lot reference |
| `qty` | INTEGER | Moved quantity |

### `stock` TimeSeries

| Column | Type | Description |
| --- | --- | --- |
| `timestamp` | TIMESTAMP, row key | Sample time in UTC |
| `total_qty` | INTEGER | Sum of on-hand qty across active lots |
| `low_count` | INTEGER | Ingredients below par |

## Bridge Internals and API Surface

### Node.js API routes

The browser talks to `src/server.js`, which uses Node's built-in `node:http` module and serves the dashboard files too.

| Method | Route | Function |
| --- | --- | --- |
| GET | `/api/health` | Real native database check; demo reports no database |
| GET | `/api/kitchen` | Stations, active tickets, summary, simulator status |
| GET | `/api/events` | Newest 100 ticket events |
| GET | `/api/history?hours=24` | Up to 1,000 backlog samples, 1–168h window |
| POST | `/api/tickets/fire` | Fire a ticket: `{ticketId, stationId, dishTag}` |
| POST | `/api/tickets/complete` | Complete a ticket and use its recipe's ingredients: `{ticketId}` |
| GET | `/api/inventory` | Ingredients with on-hand qty and low flags |
| GET | `/api/movements` | Newest 100 inventory movements |
| GET | `/api/stock-history?hours=24` | Stock-level history, 1–168h window |
| POST | `/api/inventory/receive` | Receive a lot: `{lotId, ingredientId, qty, expiresInDays?}` |
| POST | `/api/inventory/consume` | Consume or waste: `{consumeId, lotId, qty, kind?}` |
| POST | `/api/simulator/start` | Start the simulator timer; send `{}` |
| POST | `/api/simulator/stop` | Stop the simulator timer; send `{}` |

POST routes require `Content-Type: application/json`. Firing a ticket, receiving a lot, or recording a consume/waste returns 201 the first time and 200 for a matching retry. Completing a ticket returns 200. Invalid input returns 400, unknown tickets/lots return 404, conflicts return 409 (busy station, reused ID with a different payload, empty lot, not enough stock), and native failures return 503.

### Same CRUD, different domain

Every GridDB access still goes through three primitives in `python/kitchen.py`: `put` (create/update upsert), `get` (single row by key), and `read` (TQL via `container.query(tql).fetch()`). The inventory operations reuse them exactly:

- `receive` puts a `lots` row, then projects a `movements` row and a `stock` sample — the same write-plus-projection shape as firing a ticket.
- `consume` first looks up its `consumeId` movement (a retry), then reads the lot back, decrements `qty`, deactivates at zero, and writes the movement — the same read-modify-write shape as completing a ticket.
- `complete` marks the ticket done, then runs `consume_for_ticket`: it looks up the dish's recipe by tag prefix (`BURGER-12` → `BURGER`), reads active lots sorted by `expires_at`, decrements them first-expiring first, and writes one `consume` movement per lot it draws from, keyed `<ticketId>_<ingredientId>_<lotId>`.
- `inventory` sums active lots per ingredient and compares against par — the same derive-state-from-authoritative-rows shape as the station board.

Lots and tickets remain the authority. If a movement or history write fails, the API returns the saved row plus a warning.

### Idempotent retries

Every write that creates something takes a caller-generated UUID: `ticketId` for fire, `lotId` for receive, and `consumeId` for consume/waste. Retrying with the same ID and payload returns the saved row with `replayed: true`; the same ID with a different payload returns 409. Completing an already completed ticket also replays, and the replay returns before ingredient consumption, so a dish never uses its ingredients twice.

After an uncertain response (for example a native timeout), retry with the same UUID instead of minting a new one. The dashboard does this for fire and receive by keeping the pending request until it succeeds.

A receive retry is checked against the original `receive` movement, not the lot's current `qty`, because the lot may already have been partly consumed. For consume, the movement row keyed by `consumeId` is the retry record. If the lot write succeeds but the movement write fails, the API returns a warning; don't retry that `consumeId`, reconcile from lots instead.

## Order and Inventory Lifecycles

The ticket lifecycle is simple: `active` distinguishes fired from completed tickets. `completed_at` is written equal to `fired_at` when a ticket is fired and overwritten on completion; the API reports `completedAt: null` while a ticket is active. Completed tickets stay queryable for the daily count.

Completion links the two lifecycles. The ticket is saved first because it is authoritative; ingredient use follows as a best-effort step like the other projections. If stock runs short, the dish still completes and the API returns a warning such as `Not enough Tomato for BURGER-12: short by 1.`, because the food has already left the station. Dishes without a recipe (any tag whose prefix is not one of the six dishes) consume nothing.

Inventory adds expiry without enforcement: `expires_at` is recorded from `expiresInDays` but nothing auto-wastes expired lots in this draft. Low-stock is the live signal: on-hand below par flags the ingredient, and the `stock` TimeSeries records how many ingredients are low over time.

## Load Simulation

The simulator (stopped by default) attempts one transition every 5 seconds. Each tick it either completes a random simulated ticket (always when every station is busy, otherwise with 45% probability) or fires a new simulated ticket at a random free station. Manually fired tickets are never completed by the simulator. Starting it in native mode writes real sample data under the configured prefix. It stops after an error, and the API reports the message in the simulator status. The dashboard exposes start/stop in the top navigation.

Because completion consumes ingredients, running the simulator drains stock: every simulated completion takes its dish's recipe out of the lots. Receiving is still manual, through the dashboard's receive form (the **+N** button prefills the amount that brings an ingredient back to par), and ad-hoc consume/waste still runs through the API.

The recipes live in `Kitchen.RECIPES` in `python/kitchen.py` (mirrored in the demo store). Quantities are whole units of each ingredient, because lot `qty` is an `INTEGER` column, so portions are demo-sized, 1 kg of cheese per burger, to make the bars move visibly:

| Dish | Uses |
| --- | --- |
| BURGER | 1 kg cheese, 1 kg tomato |
| FRIES | 1 L oil |
| RAMEN | 1 kg chicken, 1 kg flour |
| SALAD | 1 kg tomato, 20 g basil |
| PASTA | 1 kg flour, 1 kg tomato, 1 kg cheese, 10 g basil |
| STEAK | 1 L oil, 10 g basil |

## Query Patterns and Examples

A stock-history request shows the full path. An API client calls `GET /api/stock-history?hours=24`; `KitchenService.stockHistory` validates the window and sends `{operation: "stock_history", hours}` to the worker; `kitchen.stock_history` runs the TQL query against the `stock` TimeSeries and returns `{points, limit, possiblyTruncated}`.

```bash
curl 'http://127.0.0.1:3003/api/inventory'
curl 'http://127.0.0.1:3003/api/stock-history?hours=24'
curl -X POST http://127.0.0.1:3003/api/inventory/receive \
  -H 'Content-Type: application/json' \
  -d '{"lotId":"7b5207cb-92ab-491e-b410-132535258ba1","ingredientId":"TOMATO","qty":25}'
curl -X POST http://127.0.0.1:3003/api/inventory/consume \
  -H 'Content-Type: application/json' \
  -d '{"consumeId":"8b5207cb-92ab-491e-b410-132535258ba1","lotId":"7b5207cb-92ab-491e-b410-132535258ba1","qty":5}'
```

### TQL used by the worker

All reads go through `container.query(tql).fetch()` in `python/kitchen.py`. The browser never sends TQL. Each query is fixed in the worker, and only validated integers (like `hours`) or server-computed timestamps are put into it.

| Purpose | Container | TQL |
| --- | --- | --- |
| Active tickets | `tickets` | `SELECT * WHERE active LIMIT 1001` |
| Completed today | `tickets` | `SELECT * WHERE NOT active AND completed_at >= TIMESTAMP('<UTC midnight>') LIMIT 5001` |
| Backlog window | `backlog` | `SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -24) ORDER BY timestamp DESC LIMIT 1000` |
| Stock window | `stock` | `SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -24) ORDER BY timestamp DESC LIMIT 1000` |
| Active lots | `lots` | `SELECT * WHERE active LIMIT 1001` |
| Recent movements | `movements` | `SELECT * ORDER BY timestamp DESC LIMIT 100` |

The `LIMIT 1001` reads are deliberate. Fetching one row past the expected maximum lets the worker detect overflow and fail loudly, instead of silently showing a partial board or under-counting stock. Time windows run against TimeSeries containers keyed by timestamp. Business records with stable IDs live in Collections, so retries and updates can fetch them directly with `get(key)`.

## Verification

```bash
cd apps
npm run check
npm test
```

Tests cover payload validation, fire/complete/receive/consume idempotency and conflicts, empty-lot and over-consume conflicts, recipe consumption on completion (first-expiring lot first, no double use on retry, shortfall warnings), response shapes, origin checks, and HTTP status codes through the real server. They run against the in-memory demo store, which mirrors `python/kitchen.py`; they do not exercise the Python worker or prove a live GridDB Cloud connection.

## Production Integration

Station projections and stock samples are derived from app activity, not from sensors or POS data. A real deployment needs its own ingestion: ticket firing from the POS, lot receiving from the supplier flow, expiry sweeps, and reconciliation jobs for missed projections. Keep credentials, raw TQL, and container selection off the browser, and add operator auth, HTTPS, rate limits, and retention before any public deployment. The API only accepts writes from loopback origins, which is fine for a local tool but is not authentication.

Two operational notes. Each fire or complete writes the ticket, an event, a backlog sample, and 12 sensor samples, and a complete also writes the lots and movements its recipe draws from, opening each container per write. Over a public Cloud route that adds noticeable latency, so batch the projections or drop the per-station sensor containers if it matters. And a native timeout kills the worker on purpose, because the write outcome is unknown; the API then fails every request until it is restarted and the data reconciled.

## Future Work

- Real portion sizes: store quantities in grams and millilitres so recipes can use realistic amounts, and manage recipes as data instead of code.
- Expiry sweeps: nightly job that wastes expired lots and records the movement.
- Par-level tuning per weekday and supplier lead times.
- Waste analytics: waste share per ingredient and per station.
- Multi-kitchen prefixes with a shared ingredient catalog.

## Summary

This kitchen monitor is built on Node.js plus a persistent Python worker plus GridDB Native: stations and tickets cover throughput, while ingredient lots, movements, and stock history answer whether the kitchen can keep cooking.

## Related Documentation

- GridDB Python client: <https://github.com/griddb/python_client>
- Connecting to GridDB Cloud from a local environment: <https://www.griddb.net/en/blog/connecting-to-griddb-cloud-v3-2-from-your-local-dev-environment-no-vpn-no-vnet-peering/>
- GridDB data model (Collections vs TimeSeries): <https://docs.griddb.net/architecture/data-model.html>
