"""Python runner for Judge0 CE."""

from __future__ import annotations

import json
import os
import textwrap
from typing import Any

from .base import Runner, register


@register("python")
class PythonRunner(Runner):

    @property
    def language_id(self) -> int:
        return int(os.environ.get("JUDGE0_PYTHON_LANGUAGE_ID", "71"))

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
