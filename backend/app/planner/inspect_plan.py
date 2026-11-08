"""Print a compact summary of a running backend's plan.

python -m app.planner.inspect_plan <videoId> [port] [--wait SECONDS]
--wait polls until a pause is ready or the plan is final (ready / not_coding / no_captions / error).
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request


def main() -> None:
    args = sys.argv[1:]
    wait = 0.0
    if "--wait" in args:
        i = args.index("--wait")
        wait = float(args[i + 1])
        del args[i : i + 2]
    vid = args[0]
    port = args[1] if len(args) > 1 else "8000"
    deadline = time.monotonic() + wait
    while True:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v2/plan/{vid}") as r:
            d = json.load(r)
        if d["status"] != "planning" or any(p["ready"] for p in d["pauses"]) or time.monotonic() > deadline:
            break
        time.sleep(3)
    print(d["videoId"], d["status"], "|", d["verdict"]["reason"][:160])
    for s in d["sections"]:
        print(f"  {s['id']:>4} {s['startS']:>7.0f}-{s['endS']:<7.0f} {s['format']:<9} {s['language']:<10} "
              f"q={s['qualifies']!s:<5} {s['title'][:40]} | {s['evidence'][0]['text'][:60] if s['evidence'] else ''}")
    for p in d["pauses"]:
        item = p.get("exercise") or p.get("question") or {}
        print(f"  {p['id']:>4} {p['sectionId']:>4} at={p['pauseAtS']:<8} reveal={p['revealAtS']} {p['kind']:<7} "
              f"rank={p['rank']} ready={p['ready']} {item.get('title', '')[:50]}")


if __name__ == "__main__":
    main()
