"""Local SQLite store for accounts and practice events (backend/data/, gitignored).

Events are the source of truth; profiles are recomputed by replaying them (engine.replay).
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .engine import iso

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "profile.sqlite3"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_account ON events(account_id);
CREATE TABLE IF NOT EXISTS generated_refreshers (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  level TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS generated_by_concept ON generated_refreshers(concept, level);
"""


class ProfileStore:
    def __init__(self, path: Path | str | None = None, *, seed: bool = True, now: datetime | None = None):
        self.path = Path(path or os.environ.get("BREAKPOINT_PROFILE_DB") or DEFAULT_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn, conn:
            conn.executescript(_SCHEMA)
        if seed:
            from .seed import SEED_VERSION, seed_store

            with closing(self._connect()) as conn, conn:
                current = conn.execute("PRAGMA user_version").fetchone()[0]
                fresh = not conn.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
                if not fresh and current != SEED_VERSION:
                    # Seed data changed: replace only seeded events; real learner events are kept.
                    conn.execute("DELETE FROM events WHERE id LIKE 'seed-%'")
            if fresh or current != SEED_VERSION:
                seed_store(self, now or datetime.now(timezone.utc))
                with closing(self._connect()) as conn, conn:
                    conn.execute(f"PRAGMA user_version = {int(SEED_VERSION)}")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def upsert_account(self, account_id: str, display_name: str, public: bool, *, seeded: bool = False) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT INTO accounts(id, display_name, public, seeded, created_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, public=excluded.public",
                (account_id, display_name, int(public), int(seeded), iso(datetime.now(timezone.utc))),
            )

    def ensure_account(self, account_id: str) -> None:
        """Events for an unknown local id create a private account (no sign-in in this release)."""
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT OR IGNORE INTO accounts(id, display_name, public, seeded, created_at) VALUES (?,?,0,0,?)",
                (account_id, account_id, iso(datetime.now(timezone.utc))),
            )

    def set_public(self, account_id: str, public: bool) -> dict | None:
        """Opt in/out of the public profile. Returns the updated account, or None if unknown."""
        with closing(self._connect()) as conn, conn:
            cur = conn.execute("UPDATE accounts SET public = ? WHERE id = ?", (int(public), account_id))
        return self.get_account(account_id) if cur.rowcount else None

    # Generated refresher questions (lane A2's generator), kept so lane A2 can grade them by id and so
    # a learner sees the same question again until they answer it.

    def add_generated(self, question: dict) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT OR IGNORE INTO generated_refreshers(id, concept, level, payload, created_at) VALUES (?,?,?,?,?)",
                (question["id"], question["concept"], question["level"], json.dumps(question, sort_keys=True),
                 iso(datetime.now(timezone.utc))),
            )

    def generated_for(self, concept: str, level: str) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT payload FROM generated_refreshers WHERE concept = ? AND level = ? ORDER BY created_at, id",
                (concept, level),
            ).fetchall()
        return [json.loads(r["payload"]) for r in rows]

    def get_generated(self, question_id: str) -> dict | None:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload FROM generated_refreshers WHERE id = ?", (question_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_accounts(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT id, display_name, public FROM accounts ORDER BY id").fetchall()
        return [{"accountId": r["id"], "displayName": r["display_name"], "public": bool(r["public"])} for r in rows]

    def get_account(self, account_id: str) -> dict | None:
        return next((a for a in self.list_accounts() if a["accountId"] == account_id), None)

    def add_events(self, events: list[dict]) -> tuple[int, int]:
        """Insert events idempotently by id. Returns (accepted, duplicates)."""
        accepted = 0
        received = iso(datetime.now(timezone.utc))
        with closing(self._connect()) as conn, conn:
            for e in events:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO events(id, account_id, at, type, payload, received_at) VALUES (?,?,?,?,?,?)",
                    (e["id"], e["accountId"], e["at"], e["type"], json.dumps(e, sort_keys=True), received),
                )
                accepted += cur.rowcount
        return accepted, len(events) - accepted

    def events_for(self, account_id: str) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT payload FROM events WHERE account_id = ?", (account_id,)).fetchall()
        return [json.loads(r["payload"]) for r in rows]
