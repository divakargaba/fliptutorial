"""SQL runner for Judge0 CE (via SQLite).

SQL exercises are different from function-call exercises: the learner writes a
query and the expected result is a list of rows.  The wrapper creates the
schema, inserts seed data, runs the learner's query, and emits the result rows
as JSON.

Judge0 uses language id 82 for SQLite.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .base import Runner, register


@register("sql")
class SqlRunner(Runner):

    @property
    def language_id(self) -> int:
        # Judge0 CE: SQL (SQLite 3.27.2) = 82
        return int(os.environ.get("JUDGE0_SQL_LANGUAGE_ID", "82"))

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        # For SQL, args[0] is the setup SQL (CREATE TABLE + INSERT), and the
        # user's code is the query.  function_name is unused.
        # The wrapper creates the schema, runs the query, and outputs JSON.
        setup_sql = args[0] if args else ""
        # SQLite mode: output as JSON using .mode json
        return f""".bail on
{setup_sql}
.mode json
.headers on
{code}
"""

    def _parse_sandbox_output(
        self, data: dict, visible: bool,
    ) -> tuple[str, Any | None, str | None]:
        """Override: SQL output is JSON array of row objects, not our wrapper format."""
        status_id = data.get("status", {}).get("id", 0)

        if status_id == 6:
            diag = (data.get("compile_output") or "")[:1024] if visible else None
            return "syntax_error", None, diag

        if status_id == 5:
            return "time_limit", None, ("time limit exceeded" if visible else None)

        if status_id in (7, 8, 9, 10, 11, 12):
            diag = (data.get("stderr") or "")[:1024] if visible else None
            return "runtime_error", None, diag

        stdout = data.get("stdout") or ""
        stderr = data.get("stderr") or ""

        if "Error" in stderr:
            diag = stderr[:1024] if visible else None
            return "runtime_error", None, diag

        if len(stdout) > 8 * 1024:
            return "invalid_output", None, ("output too large" if visible else None)

        stdout = stdout.strip()
        if not stdout:
            # Empty result set: return empty list
            return "check", [], None

        try:
            rows = json.loads(stdout)
        except json.JSONDecodeError:
            return "invalid_output", None, ("malformed output" if visible else None)

        if not isinstance(rows, list):
            return "invalid_output", None, ("unexpected output format" if visible else None)

        # Normalize: sort rows by all columns for order-independent comparison
        # (unless the query has ORDER BY, which the exercise creator handles)
        return "check", rows, None

    def normalize_value(self, raw: Any) -> Any:
        # SQL rows come as list of dicts; normalize number types
        if isinstance(raw, list):
            result = []
            for row in raw:
                if isinstance(row, dict):
                    result.append({
                        k: int(v) if isinstance(v, float) and v == int(v) else v
                        for k, v in row.items()
                    })
                else:
                    result.append(row)
            return result
        return raw
