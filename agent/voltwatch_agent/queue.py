"""
SQLite offline queue.

Stores readings that could not be sent due to network errors.
Caps at 10,000 rows or 7 days (whichever is hit first).
Flushes oldest-first in batches of 500 via /agent/batch.
Uses reading_id as primary key for idempotency.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

MAX_ROWS = 10_000
MAX_DAYS = 7
BATCH_SIZE = 500


# ── Path ───────────────────────────────────────────────────────────────────────

def get_queue_path() -> Path:
    local_app = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    data_dir = Path(local_app) / "VoltWatch"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "queue.db"


# ── DB helpers ─────────────────────────────────────────────────────────────────

@contextmanager
def _conn(path: Path | str):
    con = sqlite3.connect(str(path))
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


# ── Queue class ────────────────────────────────────────────────────────────────

class ReadingQueue:
    """Thread-safe SQLite-backed offline queue."""

    def __init__(self, path: Path | str | None = None) -> None:
        self._path = Path(path) if path else get_queue_path()
        self._init_db()

    def _init_db(self) -> None:
        with _conn(self._path) as con:
            con.execute("""
                CREATE TABLE IF NOT EXISTS queue (
                    reading_id  TEXT PRIMARY KEY,
                    device_time TEXT NOT NULL,
                    payload     TEXT NOT NULL,
                    queued_at   TEXT NOT NULL
                )
            """)
            con.execute("CREATE INDEX IF NOT EXISTS idx_device_time ON queue(device_time)")

    # ── Write ──────────────────────────────────────────────────────────────────

    def enqueue(self, payload: dict[str, Any]) -> None:
        """
        Add a reading to the queue. Silently ignores duplicates (by reading_id).
        Prunes excess rows after inserting.
        """
        reading_id  = payload.get("readingId") or payload.get("reading_id", "")
        device_time = payload.get("deviceTime") or payload.get("device_time", "")

        if not reading_id:
            log.warning("Cannot queue reading without readingId")
            return

        with _conn(self._path) as con:
            con.execute(
                """
                INSERT OR IGNORE INTO queue (reading_id, device_time, payload, queued_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    reading_id,
                    device_time,
                    json.dumps(payload),
                    datetime.now(tz=timezone.utc).isoformat(),
                ),
            )

        self._prune()

    # ── Read ───────────────────────────────────────────────────────────────────

    def peek_batch(self) -> list[dict[str, Any]]:
        """Return up to BATCH_SIZE oldest readings (by device_time) without removing them."""
        with _conn(self._path) as con:
            rows = con.execute(
                "SELECT payload FROM queue ORDER BY device_time ASC LIMIT ?",
                (BATCH_SIZE,),
            ).fetchall()
        return [json.loads(r["payload"]) for r in rows]

    def dequeue_ids(self, reading_ids: list[str]) -> None:
        """Remove readings by their reading_id after a successful batch upload."""
        if not reading_ids:
            return
        placeholders = ",".join("?" * len(reading_ids))
        with _conn(self._path) as con:
            con.execute(
                f"DELETE FROM queue WHERE reading_id IN ({placeholders})",
                reading_ids,
            )

    def size(self) -> int:
        """Return total number of queued readings."""
        with _conn(self._path) as con:
            row = con.execute("SELECT COUNT(*) AS n FROM queue").fetchone()
        return row["n"] if row else 0

    def clear(self) -> None:
        """Empty the queue (used in tests)."""
        with _conn(self._path) as con:
            con.execute("DELETE FROM queue")

    # ── Prune ──────────────────────────────────────────────────────────────────

    def _prune(self) -> None:
        """Delete rows older than MAX_DAYS or beyond MAX_ROWS cap."""
        cutoff = (datetime.now(tz=timezone.utc) - timedelta(days=MAX_DAYS)).isoformat()
        with _conn(self._path) as con:
            con.execute("DELETE FROM queue WHERE device_time < ?", (cutoff,))
            # Keep only the newest MAX_ROWS rows
            con.execute(
                """
                DELETE FROM queue
                WHERE reading_id NOT IN (
                    SELECT reading_id FROM queue
                    ORDER BY device_time DESC
                    LIMIT ?
                )
                """,
                (MAX_ROWS,),
            )


# ── Pure helpers for backoff ───────────────────────────────────────────────────

def next_backoff(current_secs: float, max_secs: float = 300.0, jitter: float = 0.25) -> float:
    """
    Double the backoff with ±jitter, capped at max_secs.

    Args:
        current_secs:  Current backoff duration in seconds.
        max_secs:      Maximum cap (default 5 minutes).
        jitter:        Fraction of randomness applied (default ±25%).

    Returns:
        New backoff duration in seconds.
    """
    import random
    doubled = min(current_secs * 2, max_secs)
    jitter_range = doubled * jitter
    return doubled + random.uniform(-jitter_range, jitter_range)


INITIAL_BACKOFF_SEC = 5.0
