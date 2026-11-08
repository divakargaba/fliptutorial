"""Generic stdin/stdout runner (typescript, c, csharp, go, rust) and the planner's whole-program
exercises. Offline: Judge0 is stubbed."""

from __future__ import annotations

import asyncio

import pytest

from app.planner import generate
from app.planner.generate import GenerationFailed, check_coding, coding_language_for
from app.planner.classify import Section
from app.planner.vocab import coding_languages
from app.runners import SUPPORTED_LANGUAGES, get_runner
from app.runners.stdio_runner import STDIO_LANGUAGE_IDS, STDIO_LANGUAGES, StdioRunner, normalize_output
from app.testme import GenOutput, _CheckFailed
from app.transcripts import Clip, Cue


# --- registration ------------------------------------------------------------------------------


@pytest.mark.parametrize("lang", STDIO_LANGUAGES)
def test_registered_supported_and_plannable(lang):
    r = get_runner(lang)
    assert isinstance(r, StdioRunner) and r.language == lang
    assert r.language_id == STDIO_LANGUAGE_IDS[lang]
    assert lang in SUPPORTED_LANGUAGES and lang in coding_languages()


def test_language_id_env_override(monkeypatch):
    monkeypatch.setenv("JUDGE0_GO_LANGUAGE_ID", "95")
    assert type(get_runner("go"))().language_id == 95


def test_function_style_runners_untouched():
    for lang in ("python", "javascript", "java", "cpp", "sql"):
        assert not isinstance(get_runner(lang), StdioRunner)


@pytest.mark.parametrize("raw,expected", [
    ("7\n", "7"), ("7", "7"), ("a  \r\nb \r\n\r\n", "a\nb"), ("  x", "  x"), ("", ""),
])
def test_normalize_output(raw, expected):
    assert normalize_output(raw) == expected


# --- grading with a stubbed Judge0 -----------------------------------------------------------


class FakeJudge:
    """Runs a tiny 'program' (a Python callable) on the submitted stdin; records payloads."""

    def __init__(self, program, status: int = 3, stderr: str = "", compile_output: str = ""):
        self.program, self.status, self.stderr, self.compile_output = program, status, stderr, compile_output
        self.payloads: list[dict] = []

    def install(self, runner: StdioRunner) -> StdioRunner:
        judge = self

        class Resp:
            def __init__(self, data, code=201):
                self._data, self.status_code = data, code

            def json(self):
                return self._data

        class Client:
            async def post(self, url, json, headers):
                judge.payloads.append(json)
                return Resp({"token": str(len(judge.payloads) - 1)})

            async def get(self, url, headers):
                p = judge.payloads[int(url.split("/submissions/")[1].split("?")[0])]
                out = judge.program(p["stdin"]) if judge.status == 3 else ""
                return Resp({"status": {"id": judge.status}, "stdout": out, "stderr": judge.stderr,
                             "compile_output": judge.compile_output}, 200)

        runner._client = Client()  # type: ignore[assignment]
        return runner


def go_runner(program, **kw) -> tuple[StdioRunner, FakeJudge]:
    judge = FakeJudge(program, **kw)
    return judge.install(type(get_runner("go"))()), judge


def add_program(stdin: str) -> str:
    a, b = map(int, stdin.split())
    return f"{a + b}\n"


EXAMPLES = [{"args": ["3 4\n"], "expected": "7"}]
HIDDEN = [{"args": ["0 0\n"], "expected": "0"}, {"args": ["-2 5\n"], "expected": "3\n"}]


def grade(runner, mode="submit", examples=EXAMPLES, hidden=HIDDEN):
    return asyncio.run(runner.grade("package main\nfunc main() {}\n", "main", examples, hidden, mode))


def test_correct_program_passes_and_sends_stdin():
    runner, judge = go_runner(add_program)
    res = grade(runner)
    assert res.outcome == "passed" and res.passedCount == res.totalCount == 3
    assert [p["stdin"] for p in judge.payloads] == ["3 4\n", "0 0\n", "-2 5\n"]
    p = judge.payloads[0]
    assert p["language_id"] == 107 and p["enable_network"] is False
    assert p["source_code"] == "package main\nfunc main() {}\n"  # run as-is, nothing injected


def test_wrong_program_fails_and_hides_hidden_cases():
    runner, _ = go_runner(lambda s: "42\n")
    res = grade(runner)
    assert res.outcome == "wrong_answer" and res.passedCount == 0
    visible, hidden = res.results[0], res.results[1]
    assert visible.args == ["3 4\n"] and visible.expected == "7" and visible.actual == "42"
    assert hidden.args is None and hidden.expected is None and hidden.actual is None


def test_run_mode_uses_examples_only():
    runner, judge = go_runner(add_program)
    res = grade(runner, mode="run")
    assert res.totalCount == 1 and len(judge.payloads) == 1


def test_compile_error_is_syntax_error_with_visible_diagnostic():
    runner, _ = go_runner(add_program, status=6, compile_output="./main.go:3: undefined: x")
    res = grade(runner)
    assert res.outcome == "syntax_error" and res.results[0].diagnostic.startswith("./main.go")
    assert res.results[1].diagnostic is None  # hidden case never leaks compiler output


def test_runtime_error():
    runner, _ = go_runner(add_program, status=11, stderr="panic: index out of range")
    assert grade(runner).outcome == "runtime_error"


def test_bad_case_shape_is_invalid_without_calling_judge0():
    runner, judge = go_runner(add_program)
    res = grade(runner, examples=[{"args": [3, 4], "expected": 7}], hidden=[])
    assert res.outcome == "invalid_output" and not judge.payloads


# --- planner: whole-program exercises --------------------------------------------------------

CLIP = Clip("vid", "manual", "Go basics", 10.0, 0.0, (Cue("c00000001", 0.0, 5.0, "in go a for loop sums numbers"),))

GO_EXERCISE = {
    "status": "ok", "language": "go", "languageEvidence": "func main", "title": "Sum two numbers",
    "statement": "Read two integers on one line and print their sum.", "functionName": "main",
    "starterCode": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar a, b int\n\tfmt.Scan(&a, &b)\n\tfmt.Println(0)\n}\n',
    "referenceSolution": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar a, b int\n\tfmt.Scan(&a, &b)\n\tfmt.Println(a + b)\n}\n',
    "knownWrongSolution": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar a, b int\n\tfmt.Scan(&a, &b)\n\tfmt.Println(a - b)\n}\n',
    "examples": [{"argsJson": '["3 4\\n"]', "expectedJson": '"7"'}],
    "hiddenTests": [{"argsJson": '["0 0\\n"]', "expectedJson": '"0"'}, {"argsJson": '["-2 5\\n"]', "expectedJson": '"3"'},
                    {"argsJson": '["10 10\\n"]', "expectedJson": '"20"'}],
    "wrongMistake": "subtracts", "wrongFailsOnArgsJson": '["3 4\\n"]',
    "conceptTags": ["variables"], "conceptEvidenceCueIds": ["c00000001"],
}


def gen(**over) -> GenOutput:
    return GenOutput.model_validate({**GO_EXERCISE, **over})


def test_check_coding_accepts_a_go_program():
    ex, tags = check_coding(gen(), CLIP, "pe-1", "go")
    assert ex.language == "go" and ex.functionName == "main"
    assert ex.examples[0].args == ["3 4\n"] and ex.examples[0].expected == "7"


@pytest.mark.parametrize("over,msg", [
    ({"functionName": "solve"}, "main"),
    ({"examples": [{"argsJson": "[3, 4]", "expectedJson": "7"}]}, "stdin string"),
    ({"referenceSolution": GO_EXERCISE["referenceSolution"].replace('import "fmt"', 'import (\n\t"fmt"\n\t"net/http"\n)')},
     "disallowed"),
    ({"referenceSolution": GO_EXERCISE["referenceSolution"].replace("fmt.Println(a + b)", "os.Exit(a + b)")}, "disallowed"),
])
def test_check_coding_rejects_bad_programs(over, msg):
    with pytest.raises(_CheckFailed, match=msg):
        check_coding(gen(**over), CLIP, "pe-1", "go")


@pytest.mark.parametrize("lang,program", [
    ("c", "#include <stdio.h>\nint main(void) { int a, b; scanf(\"%d %d\", &a, &b); printf(\"%d\\n\", a + b); return 0; }\n"),
    ("rust", "use std::io::Read;\nfn main() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); println!(\"{}\", s.len()); }\n"),
    ("csharp", "using System;\nclass Program { static void Main() { Console.WriteLine(Console.ReadLine()); } }\n"),
    ("typescript", "declare const require: any;\nconst input: string = require(\"fs\").readFileSync(0, \"utf8\");\nconsole.log(input.trim());\n"),
])
def test_each_stdio_language_shape_is_recognised(lang, program):
    r = generate.LANG_RULES[lang]
    assert r.stdio and __import__("re").search(r.defines, program) and not r.forbidden.search(program)


@pytest.mark.parametrize("program", [
    'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, " + "world")\n}\n',
    'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tw := bufio.NewWriter(os.Stdout)\n'
    '\tdefer w.Flush()\n\tr := bufio.NewReader(os.Stdin)\n\tvar n int\n\tfmt.Fscan(r, &n)\n\tfmt.Fprintln(w, n*2)\n}\n',
])
def test_go_string_literals_and_buffered_io_are_allowed(program):
    assert not generate.LANG_RULES["go"].forbidden.search(program)


@pytest.mark.parametrize("lang", STDIO_LANGUAGES)
def test_code_sections_in_stdio_languages_are_coding(lang):
    sec = Section(0.0, 60.0, "s", "code", lang, ["loops"], True, "high", [])
    assert coding_language_for(sec) == lang


def test_stdio_prompt_describes_stdin_cases():
    from app.planner.classify import PauseSlot
    sec = Section(0.0, 60.0, "Loops", "code", "rust", ["loops"], True, "high", [])
    pr = generate.coding_prompt(CLIP, sec, PauseSlot(0, 5.0, None, "demonstration", "loops", "sum", 1), "beginner",
                                None, "rust")
    assert 'functionName is "main"' in pr and "ONE string" in pr and "standard input" in pr
    assert "one element per parameter" not in pr
