"""Python runner for Judge0 CE."""

from __future__ import annotations

import json
import os
import re
import textwrap
from typing import Any

from .base import Runner, register

_SYNTAX_ERROR = re.compile(r"^\s*(?:SyntaxError|IndentationError|TabError)\b", re.M)


@register("python")
class PythonRunner(Runner):

    @property
    def language_id(self) -> int:
        return int(os.environ.get("JUDGE0_PYTHON_LANGUAGE_ID", "71"))

    def _parse_sandbox_output(self, data: dict, visible: bool) -> tuple[str, Any | None, str | None]:
        """Python only finds syntax errors when it starts running the file, so Judge0 reports them as a
        runtime error (status 11). Classify SyntaxError / IndentationError / TabError as syntax_error."""
        outcome, value, diag = super()._parse_sandbox_output(data, visible)
        if outcome == "runtime_error" and _SYNTAX_ERROR.search(data.get("stderr") or ""):
            return "syntax_error", value, diag
        return outcome, value, diag

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        args_repr = json.dumps(args)
        return textwrap.dedent(f"""\
{code}

import json as __json
try:
    __result = {function_name}(*{args_repr})
    print(__json.dumps({{"ok": True, "value": __result}}))
except Exception as __e:
    print(__json.dumps({{"ok": False, "error": type(__e).__name__ + ": " + str(__e)}}))
""")
