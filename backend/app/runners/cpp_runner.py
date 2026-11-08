"""C++ runner for Judge0 CE."""

from __future__ import annotations

import json
import os
from typing import Any

from .base import Runner, register


def _cpp_literal(value: Any) -> str:
    """Convert a Python value to a C++ literal."""
    if value is None:
        return "0"  # no null concept for primitives
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if -(2**31) <= value <= 2**31 - 1:
            return str(value)
        return str(value) + "LL"
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return 'string(' + json.dumps(value) + ')'
    if isinstance(value, (list, tuple)):
        if not value:
            return "vector<int>{}"
        if all(isinstance(v, int) for v in value):
            return "vector<int>{" + ", ".join(str(v) for v in value) + "}"
        if all(isinstance(v, (int, float)) for v in value):
            return "vector<double>{" + ", ".join(repr(float(v)) for v in value) + "}"
        if all(isinstance(v, str) for v in value):
            return "vector<string>{" + ", ".join(json.dumps(v) for v in value) + "}"
        return "vector<int>{}"
    return "0"


def _cpp_type(value: Any) -> str:
    """Infer C++ type from a Python value."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        if -(2**31) <= value <= 2**31 - 1:
            return "int"
        return "long long"
    if isinstance(value, float):
        return "double"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        if not value:
            return "vector<int>"
        if all(isinstance(v, int) for v in value):
            return "vector<int>"
        if all(isinstance(v, (int, float)) for v in value):
            return "vector<double>"
        if all(isinstance(v, str) for v in value):
            return "vector<string>"
        return "vector<int>"
    return "int"


@register("cpp")
class CppRunner(Runner):

    @property
    def language_id(self) -> int:
        # Judge0 CE: C++ (GCC 10.2) = 54
        return int(os.environ.get("JUDGE0_CPP_LANGUAGE_ID", "54"))

    def build_wrapper(self, code: str, function_name: str, args: list[Any]) -> str:
        decls = "\n        ".join(
            f"{_cpp_type(a)} __arg{i} = {_cpp_literal(a)};"
            for i, a in enumerate(args)
        )
        arg_names = ", ".join(f"__arg{i}" for i in range(len(args)))

        return f"""#include <iostream>
#include <string>
#include <vector>
#include <sstream>
using namespace std;

{code}

template<typename T>
string __toJson(T v);

string __toJson(bool v) {{ return v ? "true" : "false"; }}
string __toJson(int v) {{ return to_string(v); }}
string __toJson(long long v) {{ return to_string(v); }}
string __toJson(double v) {{
    ostringstream oss;
    oss << v;
    return oss.str();
}}
string __toJson(const string& v) {{
    string r = "\\"";
    for (char c : v) {{
        if (c == '"') r += "\\\\\\"";
        else if (c == '\\\\') r += "\\\\\\\\";
        else if (c == '\\n') r += "\\\\n";
        else r += c;
    }}
    return r + "\\"";
}}
template<typename T>
string __toJson(const vector<T>& v) {{
    string r = "[";
    for (size_t i = 0; i < v.size(); i++) {{
        if (i > 0) r += ",";
        r += __toJson(v[i]);
    }}
    return r + "]";
}}

int main() {{
    try {{
        {decls}
        auto __result = {function_name}({arg_names});
        cout << "{{\\"ok\\":true,\\"value\\":" << __toJson(__result) << "}}" << endl;
    }} catch (exception& __e) {{
        cout << "{{\\"ok\\":false,\\"error\\":\\"" << __e.what() << "\\"}}";
    }} catch (...) {{
        cout << "{{\\"ok\\":false,\\"error\\":\\"unknown exception\\"}}";
    }}
    return 0;
}}
"""

    def normalize_value(self, raw: Any) -> Any:
        if isinstance(raw, float) and raw == int(raw) and abs(raw) < 2**53:
            return int(raw)
        if isinstance(raw, list):
            return [self.normalize_value(v) for v in raw]
        return raw
