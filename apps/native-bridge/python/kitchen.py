"""Kitchen domain operations. All mutations are serialized by one worker.

Tickets and lots are authoritative. Event, movement, backlog, sensor and stock
projections are best effort because the native API does not make these
separate container writes one transaction.
"""
import datetime as dt
import os
import random
import re
import uuid

UTC = dt.timezone.utc

STATION_IDS = [f"{p}0{n}" for p in ("G", "F", "P") for n in range(1, 5)]
ZONE_OF = {"G": "Grill", "F": "Fry", "P": "Pass"}
UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


class ConflictError(Exception):
    pass


def utc_now():
    return dt.datetime.now(UTC)


def identifier(value, pattern, label):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid {label}")
    return value


def quantity(value):
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 100000:
        raise ValueError("qty must be an integer from 1 to 100000")
    return value


def ticket_json(row):
    # row: [ticket_id, station_id, dish_tag, fired_at, completed_at, active, simulated]
    data = dict(zip(("id", "stationId", "dishTag", "firedAt", "completedAt", "active", "simulated"), row))
    if data["active"]:
        data["completedAt"] = None
    return data


def lot_json(row):
    # row: [lot_id, ingredient_id, qty, received_at, expires_at, active, simulated]
    return dict(zip(("id", "ingredientId", "qty", "receivedAt", "expiresAt", "active", "simulated"), row))


def movement_json(row):
    return dict(zip(("id", "timestamp", "type", "ingredientId", "lotId", "qty"), row))


class Kitchen:
    def __init__(self, store):
        self.store = store
        self.prefix = identifier(os.environ.get("KITCHEN_CONTAINER_PREFIX", "kitchen_demo"), r"[A-Za-z][A-Za-z0-9_]{0,40}", "container prefix")
        self.last_timestamp = dt.datetime.min.replace(tzinfo=UTC)

    def name(self, suffix):
        return f"{self.prefix}_{suffix}"

    def container(self, suffix):
        con = self.store.get_container(self.name(suffix))
        if con is None:
            raise LookupError(f"Missing {self.name(suffix)}; run npm run init and npm run seed")
        return con

    def read(self, suffix, tql):
        con = self.container(suffix)
        try:
            rs = con.query(tql).fetch()
            try:
                rows = []
                while rs.has_next():
                    rows.append(rs.next())
                return rows
            finally:
                rs.close()
        finally:
            con.close()

    def get(self, suffix, key):
        con = self.container(suffix)
        try:
            return con.get(key)
        finally:
            con.close()

    def put(self, suffix, row):
        con = self.container(suffix)
        try:
            con.put(row)
        finally:
            con.close()

    def next_timestamp(self, now):
        # TimeSeries row keys must be unique; keep millisecond precision and strictly increasing.
        timestamp = now.replace(microsecond=(now.microsecond // 1000) * 1000)
        timestamp = max(timestamp, self.last_timestamp + dt.timedelta(milliseconds=1))
        self.last_timestamp = timestamp
        return timestamp

    # ---- tickets -------------------------------------------------------

    def active(self):
        rows = self.read("tickets", "SELECT * WHERE active LIMIT 1001")
        if len(rows) > 1000:
            raise RuntimeError("Active-ticket limit exceeded; investigate data before firing more tickets")
        return rows

    def health(self):
        con = self.container("stations")
        con.close()
        return {"status": "ok", "mode": "native", "database": "reachable"}

    def seed(self):
        created = 0
        for sid in STATION_IDS:
            if self.get("stations", sid) is None:
                self.put("stations", [sid, ZONE_OF[sid[0]], ZONE_OF[sid[0]].lower(), True])
                created += 1
        ingredients = self.seed_ingredients()
        warnings = self.record_telemetry(utc_now()) + ingredients["warnings"]
        return {"created": created, "ingredientsCreated": ingredients["created"], "warnings": warnings}

    def snapshot(self):
        metadata = self.read("stations", "SELECT * ORDER BY station_id ASC LIMIT 65")
        active = self.active()
        by_station = {row[1]: ticket_json(row) for row in active}
        if len(by_station) != len(active):
            raise RuntimeError("Conflicting active tickets detected; reconcile before continuing")
        stations = [{"id": r[0], "zone": r[1], "type": r[2], "enabled": r[3], "ticket": by_station.get(r[0])} for r in metadata]
        now = utc_now()
        day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
        completed = self.read("tickets", f"SELECT * WHERE NOT active AND completed_at >= TIMESTAMP('{day}') LIMIT 5001")
        capacity = sum(1 for station in stations if station["enabled"])
        stats = {
            "capacity": capacity,
            "busy": len(active),
            "free": capacity - len(active),
            "loadPercent": round(len(active) / capacity * 100, 1) if capacity else 0,
            "completedToday": min(len(completed), 5000),
            "completedTodayTruncated": len(completed) > 5000,
        }
        return {"mode": "native", "generatedAt": now, "stations": stations, "tickets": [ticket_json(row) for row in active], "stats": stats}

    def fire(self, req):
        tid = identifier(req.get("ticketId"), UUID_PATTERN, "ticket ID").lower()
        station_id = identifier(req.get("stationId"), r"(G0[1-4]|F0[1-4]|P0[1-4])", "station ID")
        dish = identifier(req.get("dishTag", ""), r"[A-Z0-9 -]{1,16}", "dish tag")
        existing = self.get("tickets", tid)
        if existing is not None:
            if list(existing[1:3]) != [station_id, dish]:
                raise ConflictError("Ticket ID was already used for a different order")
            return {"ticket": ticket_json(existing), "replayed": True, "warnings": []}
        metadata = self.get("stations", station_id)
        if metadata is None or not metadata[3]:
            raise LookupError("Station is missing or disabled")
        if any(row[1] == station_id for row in self.active()):
            raise ConflictError("Station is already busy")
        now = utc_now()
        row = [tid, station_id, dish, now, now, True, bool(req.get("simulated", False))]
        self.put("tickets", row)
        warnings = self.project_event(row, "fired", now) + self.record_telemetry(now)
        return {"ticket": ticket_json(row), "replayed": False, "warnings": warnings}

    def complete(self, req):
        tid = identifier(req.get("ticketId"), UUID_PATTERN, "ticket ID").lower()
        row = self.get("tickets", tid)
        if row is None:
            raise LookupError("Ticket not found")
        if not row[5]:
            # Replays stop here, before consumption, so a dish never uses ingredients twice.
            return {"ticket": ticket_json(row), "replayed": True, "consumed": [], "warnings": []}
        now = utc_now()
        row[4], row[5] = now, False
        self.put("tickets", row)
        warnings = self.project_event(row, "completed", now) + self.record_telemetry(now)
        consumed, consume_warnings = self.consume_for_ticket(row, now)
        return {"ticket": ticket_json(row), "replayed": False, "consumed": consumed, "warnings": warnings + consume_warnings}

    def project_event(self, row, kind, now):
        try:
            self.put("events", [f"{row[0]}_{kind}", now, kind, row[1], row[0], row[2]])
            return []
        except Exception:
            return ["Ticket saved, but event projection failed. Reconcile from tickets."]

    def record_telemetry(self, now):
        try:
            active = self.active()
            metadata = self.read("stations", "SELECT * LIMIT 65")
            timestamp = self.next_timestamp(now)
            by_station = {row[1]: row[0] for row in active}
            capacity = sum(1 for row in metadata if row[3])
            self.put("backlog", [timestamp, len(active), capacity])
            for row in metadata:
                self.put(f"sensor_{row[0]}", [timestamp, row[0] in by_station, by_station.get(row[0], ""), "ticket_projection"])
            return []
        except Exception:
            return ["Ticket state is available, but backlog telemetry is incomplete."]

    def events(self):
        rows = self.read("events", "SELECT * ORDER BY timestamp DESC LIMIT 100")
        return [dict(zip(("id", "timestamp", "type", "stationId", "ticketId", "dishTag"), row)) for row in rows]

    def history(self, req):
        hours = req.get("hours", 24)
        if not isinstance(hours, int) or isinstance(hours, bool) or not 1 <= hours <= 168:
            raise ValueError("hours must be an integer from 1 to 168")
        rows = self.read("backlog", f"SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -{hours}) ORDER BY timestamp DESC LIMIT 1000")
        rows.reverse()
        return {"points": [dict(zip(("timestamp", "busy", "capacity"), row)) for row in rows], "limit": 1000, "possiblyTruncated": len(rows) == 1000}

    def simulate(self):
        snapshot = self.snapshot()
        free = [s for s in snapshot["stations"] if s["enabled"] and not s["ticket"]]
        simulated = [t for t in snapshot["tickets"] if t["simulated"]]
        if simulated and (not free or random.random() < 0.45):
            return self.complete({"ticketId": random.choice(simulated)["id"]})
        if free:
            dishes = ["BURGER", "FRIES", "RAMEN", "SALAD", "PASTA", "STEAK"]
            return self.fire({"ticketId": str(uuid.uuid4()), "stationId": random.choice(free)["id"], "dishTag": f"{random.choice(dishes)}-{uuid.uuid4().hex[:2].upper()}", "simulated": True})
        return {"warnings": self.record_telemetry(utc_now())}

    # ---- inventory -----------------------------------------------------

    DEFAULT_INGREDIENTS = (("TOMATO", "Tomato", "kg", 20), ("CHEESE", "Cheese", "kg", 15), ("FLOUR", "Flour", "kg", 30), ("CHICKEN", "Chicken", "kg", 25), ("BASIL", "Basil", "g", 500), ("OIL", "Oil", "L", 10))

    # Bill of materials per dish, keyed by the dish tag prefix (BURGER-12 -> BURGER).
    # Quantities are whole units of each ingredient (kg, g, L) because lot qty is an
    # INTEGER column; they are demo-sized so stock visibly drains under the simulator.
    RECIPES = {
        "BURGER": {"CHEESE": 1, "TOMATO": 1},
        "FRIES": {"OIL": 1},
        "RAMEN": {"CHICKEN": 1, "FLOUR": 1},
        "SALAD": {"TOMATO": 1, "BASIL": 20},
        "PASTA": {"FLOUR": 1, "TOMATO": 1, "CHEESE": 1, "BASIL": 10},
        "STEAK": {"OIL": 1, "BASIL": 10},
    }

    def consume_for_ticket(self, row, now):
        """Use a completed ticket's ingredients, first-expiring lot first.

        The ticket is already saved as completed, so this is best effort like the other
        projections: a shortfall or failed write becomes a warning instead of undoing
        the completion. Unknown dishes (no recipe) consume nothing.
        """
        recipe = self.RECIPES.get(row[2].split("-")[0].strip())
        if not recipe:
            return [], []
        consumed, warnings = [], []
        try:
            lots = sorted((list(r) for r in self.lots_active()), key=lambda r: (r[4], r[0]))
            for iid, need in recipe.items():
                used = 0
                for lot in lots:
                    if used == need:
                        break
                    if lot[1] != iid or not lot[5] or lot[2] <= 0:
                        continue
                    take = min(need - used, lot[2])
                    lot[2] -= take
                    if lot[2] == 0:
                        lot[5] = False
                    self.put("lots", lot)
                    used += take
                    try:
                        # Keyed by ticket + ingredient + lot, so the audit trail links back to the dish.
                        self.put("movements", [f"{row[0]}_{iid}_{lot[0]}", now, "consume", iid, lot[0], take])
                    except Exception:
                        warnings.append("Lot updated, but a consume movement projection failed. Reconcile from lots.")
                if used:
                    consumed.append({"ingredientId": iid, "qty": used})
                if used < need:
                    warnings.append(f"Not enough {iid.title()} for {row[2]}: short by {need - used}.")
        except Exception:
            warnings.append("Ticket completed, but ingredient consumption is incomplete. Reconcile from lots.")
        warnings += self.record_stock(now)
        return consumed, warnings

    def seed_ingredients(self):
        created = 0
        for iid, name, unit, par in self.DEFAULT_INGREDIENTS:
            if self.get("ingredients", iid) is None:
                self.put("ingredients", [iid, name, unit, par, True])
                created += 1
        warnings = self.record_stock(utc_now())
        return {"created": created, "warnings": warnings}

    def lots_active(self):
        rows = self.read("lots", "SELECT * WHERE active LIMIT 1001")
        if len(rows) > 1000:
            raise RuntimeError("Active-lot limit exceeded; on-hand totals would be incomplete")
        return rows

    def on_hand(self):
        totals = {}
        for row in self.lots_active():
            totals[row[1]] = totals.get(row[1], 0) + row[2]
        return totals

    def inventory(self):
        metadata = self.read("ingredients", "SELECT * ORDER BY ingredient_id ASC LIMIT 65")
        hand = self.on_hand()
        items = [{"id": r[0], "name": r[1], "unit": r[2], "parLevel": r[3], "enabled": r[4], "onHand": hand.get(r[0], 0), "low": hand.get(r[0], 0) < r[3]} for r in metadata]
        return {"items": items, "lowCount": sum(1 for i in items if i["low"]), "generatedAt": utc_now()}

    def receive(self, req):
        lid = identifier(req.get("lotId"), UUID_PATTERN, "lot ID").lower()
        iid = identifier(req.get("ingredientId"), r"[A-Z]{2,12}", "ingredient ID")
        qty = quantity(req.get("qty"))
        days = req.get("expiresInDays", 7)
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 365:
            raise ValueError("expiresInDays must be an integer from 1 to 365")
        existing = self.get("lots", lid)
        if existing is not None:
            # Retry of the same delivery: compare against the original receive movement,
            # because the lot's qty may already have been consumed.
            received = self.get("movements", f"{lid}_receive")
            if existing[1] != iid or (received is not None and received[5] != qty):
                raise ConflictError("Lot ID was already used for a different delivery")
            return {"lot": lot_json(existing), "replayed": True, "warnings": []}
        meta = self.get("ingredients", iid)
        if meta is None or not meta[4]:
            raise LookupError("Ingredient is missing or disabled")
        now = utc_now()
        row = [lid, iid, qty, now, now + dt.timedelta(days=days), True, bool(req.get("simulated", False))]
        self.put("lots", row)
        try:
            self.put("movements", [f"{lid}_receive", now, "receive", iid, lid, qty])
            warnings = []
        except Exception:
            warnings = ["Lot saved, but movement projection failed. Reconcile from lots."]
        warnings += self.record_stock(now)
        return {"lot": lot_json(row), "replayed": False, "warnings": warnings}

    def consume(self, req):
        cid = identifier(req.get("consumeId"), UUID_PATTERN, "consume ID").lower()
        lid = identifier(req.get("lotId"), UUID_PATTERN, "lot ID").lower()
        qty = quantity(req.get("qty"))
        kind = req.get("kind", "consume")
        if kind not in ("consume", "waste"):
            raise ValueError("kind must be consume or waste")
        # The movement row, keyed by the caller's consumeId, doubles as the retry record.
        prior = self.get("movements", cid)
        if prior is not None:
            if prior[4] != lid or prior[2] != kind or prior[5] != qty:
                raise ConflictError("consumeId was already used for a different movement")
            return {"lot": lot_json(self.get("lots", lid)), "replayed": True, "warnings": []}
        row = self.get("lots", lid)
        if row is None:
            raise LookupError("Lot not found")
        if not row[5] or row[2] <= 0:
            raise ConflictError("Lot is empty")
        if qty > row[2]:
            raise ConflictError("Not enough stock in this lot")
        now = utc_now()
        row[2] -= qty
        if row[2] == 0:
            row[5] = False
        self.put("lots", row)
        try:
            self.put("movements", [cid, now, kind, row[1], lid, qty])
            warnings = []
        except Exception:
            warnings = ["Lot updated, but movement projection failed. Do not retry this consumeId; reconcile from lots."]
        warnings += self.record_stock(now)
        return {"lot": lot_json(row), "replayed": False, "warnings": warnings}

    def movements(self):
        rows = self.read("movements", "SELECT * ORDER BY timestamp DESC LIMIT 100")
        return [movement_json(row) for row in rows]

    def record_stock(self, now):
        try:
            hand = self.on_hand()
            meta = self.read("ingredients", "SELECT * LIMIT 65")
            low = sum(1 for r in meta if hand.get(r[0], 0) < r[3])
            self.put("stock", [self.next_timestamp(now), sum(hand.values()), low])
            return []
        except Exception:
            return ["Inventory state is available, but stock history is incomplete."]

    def stock_history(self, req):
        hours = req.get("hours", 24)
        if not isinstance(hours, int) or isinstance(hours, bool) or not 1 <= hours <= 168:
            raise ValueError("hours must be an integer from 1 to 168")
        rows = self.read("stock", f"SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -{hours}) ORDER BY timestamp DESC LIMIT 1000")
        rows.reverse()
        return {"points": [dict(zip(("timestamp", "totalQty", "lowCount"), row)) for row in rows], "limit": 1000, "possiblyTruncated": len(rows) == 1000}
