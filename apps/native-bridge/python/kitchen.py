"""Kitchen domain operations. All mutations are serialized by one worker.

Tickets are authoritative. Event/backlog projections are best effort because
the native API does not make these separate container writes one transaction.
"""
import datetime as dt
import os
import random
import re
import uuid

UTC = dt.timezone.utc

STATION_IDS = [f"{p}0{n}" for p in ("G", "F", "P") for n in range(1, 5)]
ZONE_OF = {"G": "Grill", "F": "Fry", "P": "Pass"}


class ConflictError(Exception):
    pass


def utc_now():
    return dt.datetime.now(UTC)


def identifier(value, pattern, label):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid {label}")
    return value


def ticket_json(row):
    # row: [id, station, dish, fired, completed, active, simulated]
    return dict(zip(("id", "spaceId", "vehicleTag", "enteredAt", "exitedAt", "active", "simulated"), row))


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

    def active(self):
        rows = self.read("tickets", "SELECT * WHERE active LIMIT 1001")
        if len(rows) > 1000:
            raise RuntimeError("Active-ticket limit exceeded; investigate data before firing more tickets")
        return rows

    def health(self):
        con = self.container("stations")
        con.close()
        return {"status": "ok", "mode": "native", "database": "reachable"}

    DEFAULT_INGREDIENTS = (("TOMATO", "Tomato", "kg", 20), ("CHEESE", "Cheese", "kg", 15), ("FLOUR", "Flour", "kg", 30), ("CHICKEN", "Chicken", "kg", 25), ("BASIL", "Basil", "g", 500), ("OIL", "Oil", "L", 10))

    def seed_ingredients(self):
        created = 0
        for iid, name, unit, par in self.DEFAULT_INGREDIENTS:
            if self.get("ingredients", iid) is None:
                self.put("ingredients", [iid, name, unit, par, True])
                created += 1
        warnings = self.record_stock(utc_now())
        return {"created": created, "warnings": warnings}

    def lots_active(self):
        return self.read("lots", "SELECT * WHERE active LIMIT 1001")

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
        lid = identifier(req.get("lotId"), r"[0-9a-fA-F-]{36}", "lot ID")
        uuid.UUID(lid)
        iid = identifier(req.get("ingredientId"), r"[A-Z]{2,12}", "ingredient ID")
        qty = req.get("qty")
        if not isinstance(qty, int) or not 1 <= qty <= 100000:
            raise ValueError("qty must be an integer from 1 to 100000")
        if self.get("lots", lid) is not None:
            raise ConflictError("Lot ID was already received")
        meta = self.get("ingredients", iid)
        if meta is None or not meta[4]:
            raise LookupError("Ingredient is missing or disabled")
        now = utc_now()
        days = req.get("expiresInDays", 7)
        if not isinstance(days, int) or not 1 <= days <= 365:
            raise ValueError("expiresInDays must be an integer from 1 to 365")
        row = [lid, iid, qty, now, now + dt.timedelta(days=days), True, bool(req.get("simulated", False))]
        self.put("lots", row)
        try:
            self.put("movements", [f"{lid}_receive", now, "receive", iid, lid, qty])
            movement_warning = []
        except Exception:
            movement_warning = ["Lot saved, but movement projection failed. Reconcile from lots."]
        warnings = movement_warning + self.record_stock(now)
        return {"lot": {"id": lid, "ingredientId": iid, "qty": qty}, "replayed": False, "warnings": warnings}

    def consume(self, req):
        lid = identifier(req.get("lotId"), r"[0-9a-fA-F-]{36}", "lot ID")
        qty = req.get("qty")
        if not isinstance(qty, int) or not 1 <= qty <= 100000:
            raise ValueError("qty must be an integer from 1 to 100000")
        kind = req.get("kind", "consume")
        if kind not in ("consume", "waste"):
            raise ValueError("kind must be consume or waste")
        row = self.get("lots", lid)
        if row is None:
            raise LookupError("Lot not found")
        if not row[5] or row[2] <= 0:
            return {"lot": {"id": row[0], "ingredientId": row[1], "qty": 0}, "replayed": True, "warnings": []}
        if qty > row[2]:
            raise ConflictError("Not enough stock in this lot")
        now = utc_now()
        row[2] -= qty
        if row[2] == 0:
            row[5] = False
        self.put("lots", row)
        try:
            self.put("movements", [f"{lid}_{kind}_{now.isoformat()}", now, kind, row[1], lid, qty])
            movement_warning = []
        except Exception:
            movement_warning = ["Lot updated, but movement projection failed. Reconcile from lots."]
        warnings = movement_warning + self.record_stock(now)
        return {"lot": {"id": row[0], "ingredientId": row[1], "qty": row[2]}, "replayed": False, "warnings": warnings}

    def movements(self):
        rows = self.read("movements", "SELECT * ORDER BY timestamp DESC LIMIT 100")
        return [dict(zip(("id", "timestamp", "type", "ingredientId", "lotId", "qty"), row)) for row in rows]

    def record_stock(self, now):
        try:
            hand = self.on_hand()
            meta = self.read("ingredients", "SELECT * LIMIT 65")
            low = sum(1 for r in meta if hand.get(r[0], 0) < r[3])
            total = sum(hand.values())
            timestamp = now.replace(microsecond=(now.microsecond // 1000) * 1000)
            timestamp = max(timestamp, self.last_timestamp + dt.timedelta(milliseconds=1))
            self.last_timestamp = timestamp
            self.put("stock", [timestamp, total, low])
            return []
        except Exception:
            return ["Inventory state is available, but stock history is incomplete."]

    def stock_history(self, req):
        hours = req.get("hours", 24)
        if not isinstance(hours, int) or not 1 <= hours <= 168:
            raise ValueError("hours must be an integer from 1 to 168")
        rows = self.read("stock", f"SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -{hours}) ORDER BY timestamp DESC LIMIT 1000")
        rows.reverse()
        return {"points": [dict(zip(("timestamp", "totalQty", "lowCount"), row)) for row in rows], "limit": 1000, "possiblyTruncated": len(rows) == 1000}

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
        spaces = [{"id": r[0], "zone": r[1], "type": r[2], "enabled": r[3], "session": by_station.get(r[0])} for r in metadata]
        now = utc_now()
        day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
        completed = self.read("tickets", f"SELECT * WHERE NOT active AND completed_at >= TIMESTAMP('{day}') LIMIT 5001")
        capacity = sum(1 for space in spaces if space['enabled'])
        return {"mode": "native", "generatedAt": now, "spaces": spaces, "stats": {"capacity": capacity, "occupied": len(active), "available": capacity - len(active), "occupancyPercent": round(len(active) / capacity * 100, 1) if capacity else 0, "completedToday": min(len(completed), 5000), "completed": len(completed), "revenueTodayCents": 0, "revenueTruncated": len(completed) > 5000}, "sessions": [ticket_json(row) for row in active]}

    def fire(self, req):
        tid = identifier(req.get("ticketId"), r"[0-9a-fA-F-]{36}", "ticket ID")
        uuid.UUID(tid)
        station_id = identifier(req.get("stationId"), r"(G0[1-4]|F0[1-4]|P0[1-4])", "station ID")
        dish = identifier(req.get("dishTag", ""), r"[A-Z0-9 -]{1,16}", "dish tag")
        existing = self.get("tickets", tid)
        if existing is not None:
            if existing[1:3] != [station_id, dish]:
                raise ConflictError("Ticket ID was already used for a different order")
            return {"session": ticket_json(existing), "replayed": True, "warnings": []}
        metadata = self.get("stations", station_id)
        if metadata is None or not metadata[3]:
            raise LookupError("Station is missing or disabled")
        active = self.active()
        if any(row[1] == station_id for row in active):
            raise ConflictError("Station is already busy")
        now = utc_now()
        row = [tid, station_id, dish, now, now, True, bool(req.get("simulated", False))]
        self.put("tickets", row)
        warnings = self.project_event(row, "fired", now) + self.record_telemetry(now)
        return {"session": ticket_json(row), "replayed": False, "warnings": warnings}

    def complete(self, req):
        tid = identifier(req.get("ticketId"), r"[0-9a-fA-F-]{36}", "ticket ID")
        row = self.get("tickets", tid)
        if row is None:
            raise LookupError("Ticket not found")
        if not row[5]:
            return {"session": ticket_json(row), "replayed": True, "warnings": []}
        now = utc_now()
        row[4], row[5] = now, False
        self.put("tickets", row)
        warnings = self.project_event(row, "completed", now) + self.record_telemetry(now)
        return {"session": ticket_json(row), "replayed": False, "warnings": warnings}

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
            timestamp = now.replace(microsecond=(now.microsecond // 1000) * 1000)
            timestamp = max(timestamp, self.last_timestamp + dt.timedelta(milliseconds=1))
            self.last_timestamp = timestamp
            by_station = {row[1]: row[0] for row in active}
            capacity = sum(1 for row in metadata if row[3])
            self.put("backlog", [timestamp, len(active), capacity])
            for row in metadata:
                self.put(f"sensor_{row[0]}", [timestamp, row[0] in by_station, by_station.get(row[0], ""), "ticket_projection"])
            # Back-compat: also mirror into occupancy when that container exists.
            try:
                self.put("occupancy", [timestamp, len(active), capacity])
            except Exception:
                pass
            return []
        except Exception:
            return ["Ticket state is available, but backlog telemetry is incomplete."]

    def events(self):
        rows = self.read("events", "SELECT * ORDER BY timestamp DESC LIMIT 100")
        return [dict(zip(("id", "timestamp", "type", "spaceId", "sessionId", "vehicleTag", "feeCents"), [*row, 0])) for row in rows]

    def history(self, req):
        hours = req.get("hours", 24)
        if not isinstance(hours, int) or not 1 <= hours <= 168:
            raise ValueError("hours must be an integer from 1 to 168")
        try:
            rows = self.read("backlog", f"SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -{hours}) ORDER BY timestamp DESC LIMIT 1000")
        except Exception:
            rows = self.read("occupancy", f"SELECT * WHERE timestamp > TIMESTAMPADD(HOUR, NOW(), -{hours}) ORDER BY timestamp DESC LIMIT 1000")
        rows.reverse()
        return {"points": [dict(zip(("timestamp", "occupied", "capacity"), row)) for row in rows], "limit": 1000, "possiblyTruncated": len(rows) == 1000}

    def simulate(self):
        snapshot = self.snapshot()
        available = [s for s in snapshot['spaces'] if s['enabled'] and not s['session']]
        simulated = [s for s in snapshot['sessions'] if s['simulated']]
        if simulated and (not available or random.random() < 0.45):
            return self.complete({"ticketId": random.choice(simulated)['id']})
        if available:
            dishes = ["BURGER", "FRIES", "RAMEN", "SALAD", "PASTA", "STEAK"]
            return self.fire({"ticketId": str(uuid.uuid4()), "stationId": random.choice(available)['id'], "dishTag": f"{random.choice(dishes)}-{uuid.uuid4().hex[:2].upper()}", "simulated": True})
        return {"warnings": self.record_telemetry(utc_now())}
