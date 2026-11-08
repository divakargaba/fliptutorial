"""Java runner for Judge0 CE."""

from __future__ import annotations

import json
import os
from typing import Any

from .base import Runner, register


def _java_literal(value: Any) -> str:
    """Convert a Python value to a Java literal inside a method body."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if -(2**31) <= value <= 2**31 - 1:
            return str(value)
        return str(value) + "L"
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        if not value:
            return "new Object[]{}"
        # Infer element type from first element
        first = value[0]
        if all(isinstance(v, int) for v in value):
            return "new int[]{" + ", ".join(str(v) for v in value) + "}"
        if all(isinstance(v, (int, float)) for v in value):
            return "new double[]{" + ", ".join(repr(float(v)) for v in value) + "}"
        if all(isinstance(v, str) for v in value):
            return "new String[]{" + ", ".join(json.dumps(v) for v in value) + "}"
        return "new Object[]{" + ", ".join(_java_literal(v) for v in value) + "}"
    return "null"


def _java_arg_decl(idx: int, value: Any) -> str:
    """Declare a local variable for an argument."""
    name = f"__arg{idx}"
    if isinstance(value, bool):
        return f"boolean {name} = {_java_literal(value)};"
    if isinstance(value, int):
        if -(2**31) <= value <= 2**31 - 1:
            return f"int {name} = {_java_literal(value)};"
        return f"long {name} = {_java_literal(value)};"
    if isinstance(value, float):
        return f"double {name} = {_java_literal(value)};"
    if isinstance(value, str):
        return f"String {name} = {_java_literal(value)};"
    if isinstance(value, (list, tuple)):
        if not value:
            return f"Object[] {name} = new Object[]{{}};"
        first = value[0]
        if all(isinstance(v, int) for v in value):
            return f"int[] {name} = {_java_literal(value)};"
        if all(isinstance(v, (int, float)) for v in value):
            return f"double[] {name} = {_java_literal(value)};"
        if all(isinstance(v, str) for v in value):
            return f"String[] {name} = {_java_literal(value)};"
        return f"Object[] {name} = {_java_literal(value)};"
    return f"Object {name} = null;"


@register("java")
class JavaRunner(Runner):

    @property
    def language_id(self) -> int:
        # Judge0 CE: Java (OpenJDK 13) = 62
        return int(os.environ.get("JUDGE0_JAVA_LANGUAGE_ID", "62"))

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        # Java wrapper: the user writes a class with a static method.
        # We wrap it in a Main class that calls the function and prints JSON.
        decls = "\n            ".join(_java_arg_decl(i, v) for i, v in enumerate(args))
        arg_names = ", ".join(f"__arg{i}" for i in range(len(args)))

        # For JSON output, we use a simple manual approach to avoid import issues.
        # The user's code defines a class with static methods, we import it.
        return f"""{code}

class Main {{
    private static String toJson(Object v) {{
        if (v == null) return "null";
        if (v instanceof Boolean) return v.toString();
        if (v instanceof Number) return v.toString();
        if (v instanceof String) {{
            String s = (String) v;
            return "\\"" + s.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replace("\\n", "\\\\n").replace("\\r", "\\\\r").replace("\\t", "\\\\t") + "\\"";
        }}
        if (v instanceof int[]) {{
            int[] a = (int[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {{
                if (i > 0) sb.append(",");
                sb.append(a[i]);
            }}
            return sb.append("]").toString();
        }}
        if (v instanceof double[]) {{
            double[] a = (double[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {{
                if (i > 0) sb.append(",");
                sb.append(a[i]);
            }}
            return sb.append("]").toString();
        }}
        if (v instanceof String[]) {{
            String[] a = (String[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {{
                if (i > 0) sb.append(",");
                sb.append(toJson(a[i]));
            }}
            return sb.append("]").toString();
        }}
        if (v instanceof Object[]) {{
            Object[] a = (Object[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {{
                if (i > 0) sb.append(",");
                sb.append(toJson(a[i]));
            }}
            return sb.append("]").toString();
        }}
        return v.toString();
    }}

    public static void main(String[] __args) {{
        try {{
            {decls}
            Object __result = Solution.{function_name}({arg_names});
            System.out.println("{{\\"ok\\":true,\\"value\\":" + toJson(__result) + "}}");
        }} catch (Exception __e) {{
            System.out.println("{{\\"ok\\":false,\\"error\\":\\"" + __e.getClass().getSimpleName() + ": " + String.valueOf(__e.getMessage()).replace("\\"", "'") + "\\"}}");
        }}
    }}
}}
"""

    def normalize_value(self, raw: Any) -> Any:
        # Java longs come back as ints in JSON when small; normalize floats
        if isinstance(raw, float) and raw == int(raw) and abs(raw) < 2**53:
            return int(raw)
        if isinstance(raw, list):
            return [self.normalize_value(v) for v in raw]
        return raw
