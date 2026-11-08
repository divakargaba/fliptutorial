"""JavaScript (Node.js) runner for Judge0 CE."""

from __future__ import annotations

import json
import os
from typing import Any

from .base import Runner, register


def _js_literal(value: Any) -> str:
    """Convert a Python value to a JavaScript literal."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_js_literal(v) for v in value) + "]"
    return json.dumps(value)


@register("javascript")
class JavaScriptRunner(Runner):

    @property
    def language_id(self) -> int:
        # Judge0 CE: Node.js 18 = 93, Node.js 12 = 63
        return int(os.environ.get("JUDGE0_JAVASCRIPT_LANGUAGE_ID", "93"))

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        args_str = ", ".join(_js_literal(a) for a in args)
        return f"""{code}

try {{
  const __result = {function_name}({args_str});
  console.log(JSON.stringify({{ok: true, value: __result}}));
}} catch (__e) {{
  console.log(JSON.stringify({{ok: false, error: (__e.constructor.name || "Error") + ": " + String(__e.message || __e)}}));
}}
"""

    def normalize_value(self, raw: Any) -> Any:
        # JavaScript doesn't distinguish int/float; JSON parse gives float for
        # all numbers. Convert whole-number floats to int for comparison with
        # Python-origin expected values.
        if isinstance(raw, float) and raw == int(raw) and abs(raw) < 2**53:
            return int(raw)
        if isinstance(raw, list):
            return [self.normalize_value(v) for v in raw]
        return raw
