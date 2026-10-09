"""Closed SQLite snapshot measurements; stdout contains aggregates/digests only."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time

LIMITS = {"maxFileBytes": 1073741824, "maxSchemaObjects": 1024,
          "maxTables": 256, "maxColumns": 64, "maxRowsPerTable": 1000000,
          "maxCategories": 256, "maxCategoryBytes": 256,
          "maxQueries": 600, "maxVmOperations": 100000000}
GROWTH_TABLES = ["runs", "messages", "tools", "approvals", "checkpoints",
                 "session_inputs", "session_turns", "provider_attempts",
                 "message_parts", "attempt_cleanup", "session_documents", "session_events"]


class Refusal(Exception):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False).encode()).hexdigest()


def identifier(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value):
        raise Refusal("unsupported_schema_identifier")
    return '"' + value + '"'


def fingerprint(path, deadline):
    try:
        before = path.lstat()
    except FileNotFoundError:
        return {"exists": False, "bytes": None, "sha256": None,
                "inode": None, "device": None, "mtimeNs": None}
    if not stat.S_ISREG(before.st_mode):
        raise Refusal("non_regular_file")
    if before.st_size > LIMITS["maxFileBytes"]:
        raise Refusal("file_byte_bound")
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise Refusal("file_changed_during_open")
        while True:
            if time.monotonic() > deadline:
                raise Refusal("inspection_deadline")
            chunk = stream.read(1048576)
            if not chunk:
                break
            h.update(chunk)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise Refusal("file_changed_during_hash")
    return {"exists": True, "bytes": before.st_size, "sha256": h.hexdigest(),
            "inode": before.st_ino, "device": before.st_dev, "mtimeNs": before.st_mtime_ns}


def inspect(path, timeout_ms):
    started = time.monotonic()
    # Reserve the final quarter of the overall budget for after fingerprints.
    deadline = started + timeout_ms / 1000
    query_deadline = started + timeout_ms * 0.75 / 1000
    files = {"primary": path, "wal": Path(str(path) + "-wal"),
             "shm": Path(str(path) + "-shm"), "effects": Path(str(path) + ".effects.sqlite"),
             "effectsWal": Path(str(path) + ".effects.sqlite-wal"),
             "effectsShm": Path(str(path) + ".effects.sqlite-shm")}
    report = {"schemaVersion": 1, "kind": "history-storage-cost", "status": "refused_before_open",
              "admission": {"callerAssertedClosedSnapshot": True,
                            "uriMode": "ro", "immutable": True, "opened": False},
              "bounds": {**LIMITS, "timeoutMs": timeout_ms}, "limitations": [],
              "growthTableSelection": GROWTH_TABLES}
    connection = None
    queries, vm_operations = 0, 0

    def query(sql, parameters=()):
        nonlocal queries
        queries += 1
        if queries > LIMITS["maxQueries"] or time.monotonic() > query_deadline:
            raise Refusal("query_budget")
        return connection.execute(sql, parameters)

    def progress():
        nonlocal vm_operations
        vm_operations += 10000
        return int(time.monotonic() > query_deadline or vm_operations > LIMITS["maxVmOperations"])

    try:
        report["filesBefore"] = {key: fingerprint(value, query_deadline) for key, value in files.items()}
        if not report["filesBefore"]["primary"]["exists"]:
            raise Refusal("primary_missing")
        wal = report["filesBefore"]["wal"]
        if wal["exists"] and wal["bytes"]:
            raise Refusal("nonempty_wal_requires_snapshot_not_immutable_read")
        report["admission"]["walAbsentOrEmpty"] = True
        connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=0)
        report["admission"]["opened"] = True
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.set_progress_handler(progress, 10000)
        report["status"] = "measurement_failed"
        report["runtime"] = {"python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version}
        schema = query("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name LIMIT ?",
                       (LIMITS["maxSchemaObjects"] + 1,)).fetchall()
        if len(schema) > LIMITS["maxSchemaObjects"]:
            raise Refusal("schema_object_bound")
        tables = [row[1] for row in schema if row[0] == "table"]
        if len(tables) > LIMITS["maxTables"]:
            raise Refusal("table_bound")
        # Virtual/shadow tables can invoke modules; never inspect their contents.
        table_kinds = query("PRAGMA table_list").fetchall()
        if any(row[2] in ("virtual", "shadow") for row in table_kinds):
            raise Refusal("virtual_or_shadow_table")
        report["schema"] = {"objects": len(schema), "tables": len(tables), "sha256": digest(schema)}
        report["sqlite"] = {name: query("PRAGMA " + name).fetchone()[0]
                            for name in ["page_size", "page_count", "freelist_count", "user_version"]}
        report["tables"] = []
        for table in tables:
            columns = query("PRAGMA table_xinfo(" + identifier(table) + ")").fetchall()
            if len(columns) > LIMITS["maxColumns"] or any(row[6] != 0 for row in columns):
                raise Refusal("column_bound_or_generated_column")
            names = [row[1] for row in columns]
            expressions = ["coalesce(sum(length(CAST(" + identifier(name) + " AS BLOB))),0)" for name in names]
            aggregate = query("SELECT count(*)," + ",".join(expressions) + " FROM " + identifier(table)).fetchone()
            if aggregate[0] > LIMITS["maxRowsPerTable"]:
                raise Refusal("row_bound")
            column_bytes = dict(zip(names, aggregate[1:]))
            report["tables"].append({"table": table, "selectedGrowthTable": table in GROWTH_TABLES,
                                     "rows": aggregate[0], "serializedColumnBytes": column_bytes,
                                     "logicalBytes": sum(aggregate[1:]),
                                     "dataBytes": column_bytes.get("data", 0)})
        report["categories"] = []
        for table, category in [("session_events", "type"), ("events", "type"), ("session_documents", "kind")]:
            measured = next((row for row in report["tables"] if row["table"] == table), None)
            if measured is None or category not in measured["serializedColumnBytes"] or "data" not in measured["serializedColumnBytes"]:
                continue
            largest = query("SELECT coalesce(max(length(CAST(" + identifier(category) + " AS BLOB))),0) FROM " +
                            identifier(table)).fetchone()[0]
            if largest > LIMITS["maxCategoryBytes"]:
                raise Refusal("category_byte_bound")
            rows = query("SELECT " + identifier(category) + ",count(*),coalesce(sum(length(CAST(data AS BLOB))),0) FROM " +
                         identifier(table) + " GROUP BY " + identifier(category) + " LIMIT ?",
                         (LIMITS["maxCategories"] + 1,)).fetchall()
            if len(rows) > LIMITS["maxCategories"]:
                raise Refusal("category_bound")
            groups = sorted([{"categorySha256": digest(row[0]), "rows": row[1], "dataBytes": row[2]} for row in rows],
                            key=lambda row: row["categorySha256"])
            report["categories"].append({"table": table, "groups": groups, "sha256": digest(groups)})
        report["dbstat"] = {"compileOptionEnabled": bool(query("SELECT sqlite_compileoption_used('ENABLE_DBSTAT_VTAB')").fetchone()[0]),
                            "status": "unavailable", "createdVirtualTable": False}
        try:
            rows = query("SELECT name,pagetype,count(*),sum(pgsize),sum(payload),sum(unused) FROM dbstat GROUP BY name,pagetype LIMIT ?",
                         (3 * LIMITS["maxSchemaObjects"] + 1,)).fetchall()
            if len(rows) > 3 * LIMITS["maxSchemaObjects"]:
                raise Refusal("dbstat_result_bound")
            owners = {row[1]: row[2] for row in schema}
            pages = [{"object": row[0], "table": owners.get(row[0], row[0]), "pageType": row[1],
                      "pages": row[2], "allocatedBytes": row[3], "payloadBytes": row[4], "unusedBytes": row[5]} for row in rows]
            allocated = sum(row["allocatedBytes"] for row in pages)
            freelist_bytes = report["sqlite"]["freelist_count"] * report["sqlite"]["page_size"]
            file_bytes = report["sqlite"]["page_count"] * report["sqlite"]["page_size"]
            report["dbstat"].update({"status": "measured", "objects": pages, "allocatedBytes": allocated,
                                     "payloadBytes": sum(row["payloadBytes"] for row in pages),
                                     "unusedBytes": sum(row["unusedBytes"] for row in pages),
                                     "freelistBytes": freelist_bytes,
                                     "unattributedBytes": file_bytes - allocated - freelist_bytes})
            for measured in report["tables"]:
                own = [row for row in pages if row["table"] == measured["table"]]
                measured["physicalIncludingIndexes"] = {key: sum(row[key] for row in own)
                                                        for key in ["pages", "allocatedBytes", "payloadBytes", "unusedBytes"]}
        except sqlite3.OperationalError as error:
            code = getattr(error, "sqlite_errorname", "SQLITE_ERROR")
            if code != "SQLITE_ERROR":
                raise
            report["dbstat"].update({"status": "unavailable", "sqliteErrorCode": code,
                                     "failureDetailSha256": digest(str(error)),
                                     "reason": "module_unavailable" if str(error) == "no such table: dbstat" else "query_error"})
            report["limitations"].append("Eponymous dbstat unavailable; physical table/index attribution is unmeasured.")
        report["status"] = "measured_unchanged"
    except Refusal as error:
        report["refusalCode"] = str(error)
    except sqlite3.Error as error:
        report["sqliteErrorCode"] = getattr(error, "sqlite_errorname", "SQLITE_ERROR")
    except (OSError, ValueError):
        report["refusalCode"] = "file_or_runtime_error"
    finally:
        if connection is not None:
            connection.close()
        try:
            report["filesAfter"] = {key: fingerprint(value, deadline) for key, value in files.items()}
            report["filesUnchanged"] = report.get("filesBefore") == report["filesAfter"]
            if not report["filesUnchanged"]:
                report["status"] = "files_changed_or_incomplete_evidence"
        except (Refusal, OSError):
            report["filesUnchanged"] = False
            report["status"] = "after_fingerprint_failed"
        report["queries"] = queries
        report["approximateVmOperations"] = vm_operations
        report["elapsedMs"] = round((time.monotonic() - started) * 1000)
        report["limitations"].extend([
            "Immutable SQLite ignores locks; caller must establish closure. Before/after digests detect persistent changes, not transient concurrent writes.",
            "Serialized-column bytes use CAST(column AS BLOB), including textual numbers; they are not SQLite record payload or file bytes.",
            "dbstat payload includes record encoding and index keys; allocated/unused bytes include page layout and do not prove leak or retention intent.",
            "Effects companions are fingerprinted only; no secondary SQLite connection is opened."])
    return report


if __name__ == "__main__":
    try:
        path = Path(sys.argv[1]).absolute()
        timeout_ms = int(sys.argv[2])
        if len(sys.argv) != 3 or not 1000 <= timeout_ms <= 60000:
            raise ValueError()
    except (IndexError, ValueError):
        sys.exit(2)
    print(json.dumps(inspect(path, timeout_ms), separators=(",", ":")))
