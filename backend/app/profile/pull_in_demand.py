"""One-time pull of hiring fields for the "In demand" card (lane B1). Run before the demo, never during it:

    cd backend && .venv/Scripts/python.exe -m app.profile.pull_in_demand [--check]

For each candidate field it asks Adzuna (Canada) how many postings match in Calgary, falling back to
Alberta, then all of Canada when Calgary is thin. It then counts how many of those postings mention each
skill and each non-code requirement (certifications, licences, degrees). The top fields go into the
``fields`` section of backend/content/skills/in-demand.json with the pull date and a link to the live
search. The old ``skills`` section stays untouched as the fallback card.

Credentials come from the environment or backend/.env (ADZUNA_APP_ID, ADZUNA_APP_KEY) and are never
printed or stored. Every response is cached under backend/data/adzuna-cache/ (gitignored), so re-runs on
the same day cost no calls. Free tier: 250 calls/day and 25/min, so calls are spaced 2.6 s apart.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUT = BACKEND_DIR / "content" / "skills" / "in-demand.json"
CACHE = BACKEND_DIR / "data" / "adzuna-cache"
API = "https://api.adzuna.com/v1/api/jobs/ca/search/1"
MIN_SPACING_S = 2.6          # 25 calls/min free tier
MAX_CALLS = 200              # stay under 250/day
THIN = 10                    # fewer title matches than this in a place -> show the next place
MENTION_SHARE = 0.10         # a requirement shows under "Also asked for" only if >= 10% of postings mention it
PLACES = [("Calgary", "city"), ("Alberta", "province"), ("", "country")]

WEF_SOURCE = {"id": "wef-foj-2025", "title": "World Economic Forum, Future of Jobs Report 2025 (fastest-growing skills)",
              "url": "https://www.weforum.org/publications/the-future-of-jobs-report-2025/"}
ADZUNA_SOURCE = {"id": "adzuna", "title": "Adzuna Canada job postings", "url": "https://www.adzuna.ca/"}

# Python / SQL / JavaScript chips show the learner's best Breakpoint level across these concepts;
# tool chips (Power BI, ArcGIS...) have no concept and say so instead of inventing a level.
PY = ["loops", "functions", "lists", "dicts", "strings"]
SQL = ["sql-select", "sql-joins"]

# Candidate fields: specific kinds of work that hire, not languages. A posting belongs to a field when its
# TITLE contains `title` (and, if set, it mentions `what` anywhere): honest "jobs in this field" counts.
FIELDS = [
    {"id": "energy-data", "name": "Energy data analytics", "title": "analyst", "what": "oil gas",
     "summary": "Turn well, pipeline and production data into reports and forecasts that operations teams act on.",
     "wef": "AI and big data",
     "skills": [("Python", "python", PY), ("SQL", "sql", SQL), ("Power BI", "power bi", None), ("Excel", "excel", None),
                ("Spotfire", "spotfire", None), ("Machine learning", "machine learning", None)],
     "requirements": [("H2S Alive", "h2s"), ("First aid", "first aid"), ("P.Eng / EIT", "p.eng"), ("Degree", "degree")]},
    {"id": "cybersecurity", "name": "Cybersecurity", "title": "cyber", "what": "",
     "summary": "Watch systems for attacks, investigate alerts and harden networks, often in energy and finance.",
     "wef": "Networks and cybersecurity",
     "skills": [("Python", "python", PY), ("Linux", "linux", None), ("SIEM / Splunk", "siem", None),
                ("Networking", "network", None), ("Azure", "azure", None), ("PowerShell", "powershell", None)],
     "requirements": [("CISSP", "cissp"), ("CompTIA Security+", "comptia"), ("CISM", "cism"), ("Security clearance", "clearance"),
                      ("Degree", "degree")]},
    {"id": "data-science", "name": "Data science", "title": "data scientist", "what": "",
     "summary": "Find patterns in business and operations data and build models that predict what happens next.",
     "wef": "AI and big data",
     "skills": [("Python", "python", PY), ("SQL", "sql", SQL), ("Statistics", "statistics", None),
                ("Machine learning", "machine learning", None), ("Power BI", "power bi", None), ("AWS", "aws", None)],
     "requirements": [("Master's", "master"), ("PhD", "phd"), ("Degree", "degree")]},
    {"id": "ml-engineering", "name": "Machine learning engineering", "title": "machine learning", "what": "",
     "summary": "Build, train and ship models into real products, from forecasting to language and vision systems.",
     "wef": "AI and big data",
     "skills": [("Python", "python", PY), ("SQL", "sql", SQL), ("PyTorch", "pytorch", None), ("TensorFlow", "tensorflow", None),
                ("AWS", "aws", None), ("Docker", "docker", None)],
     "requirements": [("Master's", "master"), ("PhD", "phd"), ("Degree", "degree")]},
    {"id": "gis", "name": "Geospatial / GIS analysis", "title": "gis", "what": "",
     "summary": "Map land, pipelines and resources and analyse location data for planning and environmental work.",
     "wef": None,
     "skills": [("Python", "python", PY), ("SQL", "sql", SQL), ("ArcGIS", "arcgis", None), ("QGIS", "qgis", None),
                ("Remote sensing", "remote sensing", None), ("FME", "fme", None)],
     "requirements": [("GISP", "gisp"), ("Degree", "degree"), ("Driver's licence", "driver")]},
    {"id": "bioinformatics", "name": "Biology big data / bioinformatics", "title": "bioinformatic", "what": "",
     "summary": "Write code that analyses DNA, RNA and protein data for research labs, hospitals and biotech.",
     "wef": "AI and big data",
     "skills": [("Python", "python", PY), ("Statistics", "statistics", None), ("Linux", "linux", None), ("SQL", "sql", SQL),
                ("Machine learning", "machine learning", None), ("Genomics", "genomics", None)],
     "requirements": [("PhD", "phd"), ("MSc", "msc"), ("Degree", "degree")]},
]


class Adzuna:
    def __init__(self) -> None:
        try:
            from dotenv import load_dotenv
            load_dotenv(BACKEND_DIR / ".env")
        except ImportError:
            pass
        self.app_id = os.environ.get("ADZUNA_APP_ID", "")
        self.app_key = os.environ.get("ADZUNA_APP_KEY", "")
        if not self.app_id or not self.app_key:
            sys.exit("Set ADZUNA_APP_ID and ADZUNA_APP_KEY in backend/.env (free key at developer.adzuna.com).")
        self.calls = 0
        self._last = 0.0
        CACHE.mkdir(parents=True, exist_ok=True)

    def count(self, what: str, where: str, extra: str = "", title: str = "") -> int:
        """Number of postings whose title contains `title` (role) and that mention `what` and `extra` anywhere,
        in `where` ("" = all of Canada)."""
        params = {"results_per_page": 1, "content-type": "application/json"}
        if what:
            params["what"] = what
        if title:
            params["title_only"] = title
        if extra:
            params["what_and"] = extra.strip()
        if where:
            params["where"] = where
        key = hashlib.sha256(f"{date.today()}|{json.dumps(params, sort_keys=True)}".encode()).hexdigest()[:20]
        cached = CACHE / f"{key}.json"
        if cached.exists():
            return int(json.loads(cached.read_text(encoding="utf-8")).get("count", 0))
        if self.calls >= MAX_CALLS:
            raise RuntimeError(f"call budget of {MAX_CALLS} reached; re-run tomorrow (cache keeps today's answers)")
        wait = MIN_SPACING_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        url = API + "?" + urllib.parse.urlencode({"app_id": self.app_id, "app_key": self.app_key, **params})
        self._last = time.monotonic()
        self.calls += 1
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "breakpoint-demo"}), timeout=30) as r:
                data = json.load(r)
        except urllib.error.HTTPError as exc:  # never echo the URL: it carries the key
            raise RuntimeError(f"Adzuna HTTP {exc.code} for what={what!r} where={where!r}") from None
        if "count" not in data:
            raise RuntimeError("Adzuna response has no 'count' field")
        cached.write_text(json.dumps({"count": data["count"], "params": params}), encoding="utf-8")
        return int(data["count"])


def search_url(title: str, what: str, where: str) -> str:
    q = {"q": " ".join(x for x in (title, what) if x)}
    if where:
        q["w"] = where
    return "https://www.adzuna.ca/search?" + urllib.parse.urlencode(q)


def pull_field(api: Adzuna, f: dict) -> dict:
    """Calgary / Alberta / Canada counts by job title; skill and requirement shares across Canada (small local
    counts would make percentages noise)."""
    counts = {kind: api.count(f["what"], place, title=f["title"]) for place, kind in PLACES}
    where, scope = next(((p, k) for p, k in PLACES if counts[k] >= THIN), ("", "country"))
    total = counts["country"]

    def share(kw: str) -> tuple[int, float]:
        # The keyword goes in what_and: folding it into `what` returns 0 when `what` already has words.
        n = api.count(f["what"], "", extra=kw, title=f["title"]) if total else 0
        return n, round(n / total, 2) if total else 0.0

    skills = []
    for label, kw, concepts in f["skills"]:
        n, sh = share(kw)
        if n:
            skills.append({"name": label, "mentions": n, "share": sh, "concepts": concepts or []})
    reqs = []
    for label, kw in f["requirements"]:
        n, sh = share(kw)
        if sh >= MENTION_SHARE:
            reqs.append({"name": label, "mentions": n, "share": sh})
    return {
        "id": f["id"], "name": f["name"], "summary": f["summary"],
        "rising": f["wef"] is not None, "wefSkill": f["wef"],
        "postings": {"calgary": counts["city"], "alberta": counts["province"], "canada": total,
                     "count": counts[scope], "where": where or "Canada", "scope": scope,
                     "searchUrl": search_url(f["title"], f["what"], where), "titleContains": f["title"],
                     "mentions": f["what"] or None},
        "skills": sorted(skills, key=lambda s: -s["mentions"])[:5],
        "alsoAskedFor": sorted(reqs, key=lambda r: -r["mentions"]),
        "tutorials": [],  # filled after each video is opened through Breakpoint and has coding challenges
    }


def main(argv: list[str]) -> None:
    api = Adzuna()
    if "--check" in argv:  # one call: confirm the 'ca' endpoint and the count field work with this key
        print(f"Adzuna Canada OK: {api.count('software developer', 'Calgary')} postings for 'software developer' in Calgary")
        return
    pulled = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fields = []
    for f in FIELDS:
        row = pull_field(api, f)
        print(f"{row['name']:34} Calgary {row['postings']['calgary']:>4} | Alberta {row['postings']['alberta']:>4} | "
              f"Canada {row['postings']['canada']:>5} -> card: {row['postings']['where']:8} "
              f"skills={[s['name'] for s in row['skills']]} also={[r['name'] for r in row['alsoAskedFor']]}")
        fields.append(row)
    fields.sort(key=lambda r: (-r["postings"]["calgary"], -r["postings"]["canada"]))
    data = json.loads(OUT.read_text(encoding="utf-8"))
    # Keep tutorials already verified through the planner (they are curated by hand, not pulled).
    kept = {f["id"]: f.get("tutorials", []) for f in data.get("fields", [])}
    for row in fields:
        row["tutorials"] = kept.get(row["id"], [])
    data["fields"] = fields[:5]
    data["fieldsPulledAt"] = pulled
    data["fieldsMethod"] = (f"Adzuna Canada postings pulled {pulled}, counted by job title: Calgary first, then Alberta, "
                            f"then Canada when a place has under {THIN}. Skill and requirement shares are the Canada-wide "
                            f"postings in the field that also mention the keyword; requirements show only when at least "
                            f"{int(MENTION_SHARE * 100)}% mention them. "
                            "Rising = matches a WEF Future of Jobs 2025 fastest-growing skill.")
    ids = {s["id"] for s in data.get("sources", [])}
    data.setdefault("sources", []).extend(s for s in (ADZUNA_SOURCE, WEF_SOURCE) if s["id"] not in ids)
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(BACKEND_DIR)} ({len(fields)} fields, {api.calls} API calls, rest from cache)")


if __name__ == "__main__":
    main(sys.argv[1:])
