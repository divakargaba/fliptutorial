"""Lane A2: per-language Judge0 wrappers.

Each runner builds a sandbox source that calls the exercise function with given
arguments and emits a JSON result on stdout. Expected values and pass flags never
enter the sandbox — comparison happens server-side, just like the v1 Python grader.

Supported languages: python, javascript, java, cpp, sql (function style) and typescript, c,
csharp, go, rust (whole programs graded on stdin/stdout, ``stdio_runner``).
"""

from __future__ import annotations

from .base import (
    Runner, RunnerResult, CaseResult, CaseOutcome,
    RunnerUnavailable, RunnerTimeout, RunnerBusy,
    SUPPORTED_LANGUAGES, get_runner, close_all,
)

# Import language modules so their @register decorators run.
from . import python_runner as _py  # noqa: F401
from . import javascript_runner as _js  # noqa: F401
from . import java_runner as _java  # noqa: F401
from . import cpp_runner as _cpp  # noqa: F401
from . import sql_runner as _sql  # noqa: F401
from . import stdio_runner as _stdio  # noqa: F401  (typescript, c, csharp, go, rust)

__all__ = [
    "Runner", "RunnerResult", "CaseResult", "CaseOutcome",
    "RunnerUnavailable", "RunnerTimeout", "RunnerBusy",
    "SUPPORTED_LANGUAGES", "get_runner", "close_all",
]
