"""Tests for Lane A2: per-language Judge0 runners.

Unit tests for wrapper generation and value normalization.
No live Judge0 calls.
"""

from __future__ import annotations

import json

import pytest

from backend.app.runners import get_runner, SUPPORTED_LANGUAGES
from backend.app.runners.base import Runner


class TestPythonRunner:
    @pytest.fixture
    def runner(self):
        return get_runner("python")

    def test_language_id(self, runner):
        assert runner.language_id == 71

    def test_wrapper_calls_function(self, runner):
        w = runner.build_wrapper("def f(x): return x*2", "f", [5])
        assert "f(*[5])" in w

    def test_wrapper_imports_json(self, runner):
        w = runner.build_wrapper("def f(): return 1", "f", [])
        assert "import json as __json" in w

    def test_wrapper_catches_exceptions(self, runner):
        w = runner.build_wrapper("def f(): raise ValueError('bad')", "f", [])
        assert "except Exception" in w

    def test_wrapper_multiple_args(self, runner):
        w = runner.build_wrapper("def add(a,b): return a+b", "add", [3, 7])
        assert "add(*[3, 7])" in w

    def test_wrapper_string_args(self, runner):
        w = runner.build_wrapper("def greet(s): return 'hi ' + s", "greet", ["world"])
        assert '"world"' in w

    def test_wrapper_bool_args(self, runner):
        w = runner.build_wrapper("def f(b): return not b", "f", [True])
        assert "true" in w.lower() or "True" in w


class TestJavaScriptRunner:
    @pytest.fixture
    def runner(self):
        return get_runner("javascript")

    def test_language_id(self, runner):
        assert runner.language_id == 93

    def test_wrapper_calls_function(self, runner):
        w = runner.build_wrapper("function f(x) { return x*2; }", "f", [5])
        assert "f(5)" in w

    def test_wrapper_uses_json_stringify(self, runner):
        w = runner.build_wrapper("function f() { return 1; }", "f", [])
        assert "JSON.stringify" in w

    def test_wrapper_string_args(self, runner):
        w = runner.build_wrapper("function f(s) { return s; }", "f", ["hello"])
        assert '"hello"' in w

    def test_wrapper_null_args(self, runner):
        w = runner.build_wrapper("function f(x) { return x; }", "f", [None])
        assert "null" in w

    def test_wrapper_bool_args(self, runner):
        w = runner.build_wrapper("function f(b) { return !b; }", "f", [True])
        assert "true" in w

    def test_wrapper_array_args(self, runner):
        w = runner.build_wrapper("function f(a) { return a; }", "f", [[1, 2, 3]])
        assert "[1, 2, 3]" in w

    def test_normalize_int_float(self, runner):
        assert runner.normalize_value(5.0) == 5
        assert isinstance(runner.normalize_value(5.0), int)

    def test_normalize_real_float(self, runner):
        assert runner.normalize_value(5.5) == 5.5
        assert isinstance(runner.normalize_value(5.5), float)

    def test_normalize_list(self, runner):
        assert runner.normalize_value([1.0, 2.0, 3.5]) == [1, 2, 3.5]


class TestJavaRunner:
    @pytest.fixture
    def runner(self):
        return get_runner("java")

    def test_language_id(self, runner):
        assert runner.language_id == 62

    def test_wrapper_has_main_class(self, runner):
        w = runner.build_wrapper(
            "class Solution { public static int add(int a, int b) { return a+b; } }",
            "add", [1, 2],
        )
        assert "class Main" in w
        assert "Solution.add" in w

    def test_wrapper_int_args(self, runner):
        w = runner.build_wrapper("class Solution { public static int f(int n) { return n; } }", "f", [42])
        assert "int __arg0 = 42;" in w

    def test_wrapper_string_args(self, runner):
        w = runner.build_wrapper("class Solution { public static String f(String s) { return s; } }", "f", ["hello"])
        assert 'String __arg0 = "hello";' in w

    def test_wrapper_int_array_args(self, runner):
        w = runner.build_wrapper("class Solution { public static int f(int[] a) { return 0; } }", "f", [[1, 2, 3]])
        assert "int[] __arg0" in w

    def test_normalize_float_to_int(self, runner):
        assert runner.normalize_value(42.0) == 42
        assert isinstance(runner.normalize_value(42.0), int)


class TestCppRunner:
    @pytest.fixture
    def runner(self):
        return get_runner("cpp")

    def test_language_id(self, runner):
        assert runner.language_id == 54

    def test_wrapper_has_includes(self, runner):
        w = runner.build_wrapper("int f(int x) { return x; }", "f", [5])
        assert "#include <iostream>" in w
        assert "#include <vector>" in w

    def test_wrapper_calls_function(self, runner):
        w = runner.build_wrapper("int f(int a, int b) { return a+b; }", "f", [3, 7])
        assert "f(__arg0, __arg1)" in w

    def test_wrapper_int_decl(self, runner):
        w = runner.build_wrapper("int f(int x) { return x; }", "f", [42])
        assert "int __arg0 = 42;" in w

    def test_wrapper_vector_decl(self, runner):
        w = runner.build_wrapper("int f(vector<int> v) { return 0; }", "f", [[1, 2]])
        assert "vector<int>" in w

    def test_wrapper_string_decl(self, runner):
        w = runner.build_wrapper("string f(string s) { return s; }", "f", ["hello"])
        assert 'string(__arg0' in w or 'string(' in w

    def test_normalize_values(self, runner):
        assert runner.normalize_value(5.0) == 5
        assert runner.normalize_value([1.0, 2.0]) == [1, 2]


class TestSqlRunner:
    @pytest.fixture
    def runner(self):
        return get_runner("sql")

    def test_language_id(self, runner):
        assert runner.language_id == 82

    def test_wrapper_includes_setup(self, runner):
        setup = "CREATE TABLE t (id INT); INSERT INTO t VALUES (1);"
        w = runner.build_wrapper("SELECT * FROM t;", "query", [setup])
        assert "CREATE TABLE" in w
        assert "SELECT * FROM t" in w
        assert ".mode json" in w

    def test_normalize_rows(self, runner):
        rows = [{"id": 1.0, "name": "test"}]
        normalized = runner.normalize_value(rows)
        assert normalized == [{"id": 1, "name": "test"}]


class TestRunnerParseSandboxOutput:
    """Test the base _parse_sandbox_output method."""

    @pytest.fixture
    def runner(self):
        return get_runner("python")

    def test_passed(self, runner):
        data = {"status": {"id": 3}, "stdout": '{"ok": true, "value": 42}\n'}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "check"
        assert value == 42

    def test_syntax_error(self, runner):
        data = {"status": {"id": 6}, "compile_output": "SyntaxError: bad"}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "syntax_error"
        assert "SyntaxError" in diag

    def test_time_limit(self, runner):
        data = {"status": {"id": 5}}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "time_limit"

    def test_runtime_error(self, runner):
        data = {"status": {"id": 11}, "stderr": "NameError: name 'x' is not defined"}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "runtime_error"

    def test_runtime_error_from_wrapper(self, runner):
        data = {"status": {"id": 3}, "stdout": '{"ok": false, "error": "TypeError: bad"}\n'}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "runtime_error"
        assert "TypeError" in diag

    def test_no_output(self, runner):
        data = {"status": {"id": 3}, "stdout": ""}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "invalid_output"

    def test_malformed_json(self, runner):
        data = {"status": {"id": 3}, "stdout": "not json\n"}
        outcome, value, diag = runner._parse_sandbox_output(data, True)
        assert outcome == "invalid_output"

    def test_hidden_no_diagnostics(self, runner):
        data = {"status": {"id": 6}, "compile_output": "SyntaxError"}
        outcome, value, diag = runner._parse_sandbox_output(data, False)
        assert outcome == "syntax_error"
        assert diag is None  # hidden case: no diagnostics
