"""Create kitchen containers; refuse incompatible schemas without changing data."""
import os
import re

STATIONS = (("station_id", "STRING"), ("zone", "STRING"), ("station_type", "STRING"), ("enabled", "BOOL"))
TICKETS = (("ticket_id", "STRING"), ("station_id", "STRING"), ("dish_tag", "STRING"), ("fired_at", "TIMESTAMP"), ("completed_at", "TIMESTAMP"), ("active", "BOOL"), ("simulated", "BOOL"))
EVENTS = (("event_id", "STRING"), ("timestamp", "TIMESTAMP"), ("event_type", "STRING"), ("station_id", "STRING"), ("ticket_id", "STRING"), ("dish_tag", "STRING"))
BACKLOG = (("timestamp", "TIMESTAMP"), ("busy", "INTEGER"), ("capacity", "INTEGER"))
SENSOR = (("timestamp", "TIMESTAMP"), ("busy", "BOOL"), ("ticket_id", "STRING"), ("source", "STRING"))
INGREDIENTS = (("ingredient_id", "STRING"), ("name", "STRING"), ("unit", "STRING"), ("par_level", "INTEGER"), ("enabled", "BOOL"))
LOTS = (("lot_id", "STRING"), ("ingredient_id", "STRING"), ("qty", "INTEGER"), ("received_at", "TIMESTAMP"), ("expires_at", "TIMESTAMP"), ("active", "BOOL"), ("simulated", "BOOL"))
MOVEMENTS = (("movement_id", "STRING"), ("timestamp", "TIMESTAMP"), ("movement_type", "STRING"), ("ingredient_id", "STRING"), ("lot_id", "STRING"), ("qty", "INTEGER"))
STOCK = (("timestamp", "TIMESTAMP"), ("total_qty", "INTEGER"), ("low_count", "INTEGER"))


def station_ids():
    ids = []
    for prefix in ("G", "F", "P"):
        for number in range(1, 5):
            ids.append(f"{prefix}0{number}")
    return ids


def initialize(store):
    import griddb_python as griddb
    prefix = os.environ.get("KITCHEN_CONTAINER_PREFIX", "kitchen_demo")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,40}", prefix):
        raise ValueError("Invalid KITCHEN_CONTAINER_PREFIX")
    schemas = [("stations", "COLLECTION", STATIONS), ("tickets", "COLLECTION", TICKETS), ("events", "COLLECTION", EVENTS), ("backlog", "TIME_SERIES", BACKLOG), ("ingredients", "COLLECTION", INGREDIENTS), ("lots", "COLLECTION", LOTS), ("movements", "COLLECTION", MOVEMENTS), ("stock", "TIME_SERIES", STOCK)]
    schemas += [(f"sensor_{sid}", "TIME_SERIES", SENSOR) for sid in station_ids()]
    results = []
    for suffix, kind, columns in schemas:
        name = f"{prefix}_{suffix}"
        info = griddb.ContainerInfo(name, [[c, getattr(griddb.Type, t)] for c, t in columns], type=getattr(griddb.ContainerType, kind), row_key=True)
        container = store.get_container(name)
        if container is not None:
            container.close()
            existing = store.get_container_info(name)
            actual = (existing.type.name, bool(existing.row_key), tuple((c[0], c[1].name) for c in existing.column_info_list))
            if actual != (kind, True, columns):
                raise RuntimeError(f"Incompatible schema: {name}; no existing data was deleted")
            results.append({"name": name, "status": "unchanged"})
        else:
            container = store.put_container(info, modifiable=False)
            container.close()
            results.append({"name": name, "status": "created"})
    return results
