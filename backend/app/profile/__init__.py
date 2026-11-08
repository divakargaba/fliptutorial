"""Lane B1 (@spectaboy): local accounts, per-concept levels, decay/refreshers, in-demand skills, matching.

Contracts: contracts/v2/README.md §3 (consume practice events) and §4 (produce the public profile).
Storage: SQLite under backend/data/ (gitignored), path overridable with BREAKPOINT_PROFILE_DB.

Endpoints (all under /v2):
  POST /events                          {events: [...]} -> {accepted, duplicates, rejected[]}  (idempotent by id)
  GET  /accounts                        -> {accounts: [{accountId, displayName, public}]}
  GET  /profile/{accountId}             -> public-profile shape (watch history never included)
  GET  /profile/{accountId}/level/{concept} -> {accountId, concept, level, levelName, rank, xp, strength}
                                           (unknown -> beginner-1; ?detail=true adds private per-concept stats)
  GET  /profile/{accountId}/levels      -> {accountId, levels: {conceptId: levelId}}
  GET  /refresher/{accountId}           -> {accountId, concept, conceptName, strength, reason, question} or 204
  GET  /skills/in-demand                -> {asOf, method, skills[]}   (?accountId= personalises the top 3)
  GET  /matches/{accountId}             -> {accountId, matches: [{accountId, displayName, why, score, fullStack}]}
Read endpoints accept `?now=<ISO time>` to simulate decay later in time (demo + tests).

Lane A2 grades refresher answers with `app.profile.skills.lookup_refresher(questionId)` (ids start `rf-`).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response

from . import engine, matching, skills
from .store import ProfileStore

router = APIRouter(prefix="/v2", tags=["profile"])

MAX_EVENTS_PER_REQUEST = 500
_store: ProfileStore | None = None


def get_store() -> ProfileStore:
    global _store
    if _store is None:
        _store = ProfileStore()
    return _store


def set_store(store: ProfileStore | None) -> None:
    """Tests (and demos) point the router at another database."""
    global _store
    _store = store


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "retryable": False}, "requestId": "profile"},
    )


def _now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    return engine.parse_time(value)


def _account_or_404(store: ProfileStore, account_id: str) -> dict | JSONResponse:
    acct = store.get_account(account_id)
    return acct if acct else _error(404, "UNKNOWN_ACCOUNT", f"no local account {account_id!r}")


def _replay(store: ProfileStore, account_id: str, now: datetime) -> engine.Replay:
    return engine.replay(store.events_for(account_id), now)


def _bad_now() -> JSONResponse:
    return _error(400, "INVALID_REQUEST", "now must be an ISO-8601 timestamp")


@router.post("/events")
async def ingest_events(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except ValueError:
        return _error(400, "INVALID_REQUEST", "body must be JSON")
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list):
        return _error(400, "INVALID_REQUEST", "body must be {events: [...]}")
    if len(events) > MAX_EVENTS_PER_REQUEST:
        return _error(413, "TOO_MANY_EVENTS", f"send at most {MAX_EVENTS_PER_REQUEST} events per request")
    store = get_store()
    valid, rejected = [], []
    for raw in events:
        event, reason = engine.validate_event(raw)
        if event is None:
            rid = raw.get("id") if isinstance(raw, dict) else None
            rejected.append({"id": rid, "reason": reason})
        else:
            valid.append(event)
    for account_id in {e["accountId"] for e in valid}:
        store.ensure_account(account_id)
    accepted, duplicates = store.add_events(valid)
    return JSONResponse({"accepted": accepted, "duplicates": duplicates, "rejected": rejected})


@router.get("/accounts")
def accounts() -> JSONResponse:
    return JSONResponse({"accounts": get_store().list_accounts()})


def build_profile(store: ProfileStore, acct: dict, now: datetime) -> dict:
    rep = _replay(store, acct["accountId"], now)
    active = sorted((st for st in rep.concepts.values() if st.active), key=lambda s: (-s.xp, s.concept))
    others = [(a, _replay(store, a["accountId"], now)) for a in store.list_accounts()
              if a["accountId"] != acct["accountId"] and a["public"]]
    return {
        "schemaVersion": 2,
        "accountId": acct["accountId"],
        "displayName": acct["displayName"],
        "public": acct["public"],
        "skills": [engine.skill_view(st, now) for st in active],
        "highlights": engine.highlights(rep),
        "refresherDue": engine.refresher_due(rep, now),
        "topInDemand": skills.top_in_demand(rep),
        "complements": [{k: m[k] for k in ("accountId", "displayName", "why")}
                        for m in matching.match(acct, rep, others)],
    }


@router.get("/profile/{account_id}")
def profile(account_id: str, now: str | None = Query(default=None)) -> JSONResponse:
    store = get_store()
    acct = _account_or_404(store, account_id)
    if isinstance(acct, JSONResponse):
        return acct
    try:
        when = _now(now)
    except ValueError:
        return _bad_now()
    return JSONResponse(build_profile(store, acct, when))


def _replay_if_known(store: ProfileStore, account_id: str, now: datetime) -> engine.Replay:
    """Unknown accounts read as brand-new learners (everyone starts at beginner-1)."""
    if store.get_account(account_id) is None:
        return engine.Replay({}, {})
    return _replay(store, account_id, now)


@router.get("/profile/{account_id}/level/{concept}")
def level(
    account_id: str, concept: str, now: str | None = Query(default=None), detail: bool = Query(default=False)
) -> JSONResponse:
    """LevelInfo `{accountId, concept, level, levelName, rank, xp, strength}` exactly (contract §4);
    unknown account or concept -> beginner-1, rank 1, xp 0, strength 0. `?detail=true` adds private extras."""
    try:
        when = _now(now)
    except ValueError:
        return _bad_now()
    rep = _replay_if_known(get_store(), account_id, when)
    st = rep.concepts.get(concept) or engine.ConceptState(concept)
    lv = st.level
    strength = st.strength(when)
    body = {
        "accountId": account_id, "concept": concept, "level": lv["id"], "levelName": lv["name"],
        "rank": lv["rank"], "xp": int(st.xp), "strength": strength,
    }
    if detail:
        nxt = engine.next_level(lv)
        body.update({
            "conceptName": engine.CONCEPTS.get(concept, {}).get("name"),
            "tier": lv["tier"],
            "nextLevel": {"level": nxt["id"], "levelName": nxt["name"], "minXp": nxt["minXp"]} if nxt else None,
            "refresherDue": st.active and strength < engine.REFRESHER_THRESHOLD,
            # Private to the learner's own extension; never part of the public profile.
            "stats": {
                "watchedS": rep.watched_for(st), "practiced": st.practiced, "passed": st.passed,
                "failed": st.failed, "skipped": st.skipped, "hintsUsed": st.hints_used, "refreshers": st.refreshers,
            },
        })
    return JSONResponse(body)


@router.get("/profile/{account_id}/levels")
def levels(account_id: str, now: str | None = Query(default=None)) -> JSONResponse:
    """`{accountId, levels: {conceptId: levelId}}` for every concept the learner has practiced
    (A3 sends this as POST /v2/plan `learnerLevels`). Unknown account -> empty map."""
    try:
        when = _now(now)
    except ValueError:
        return _bad_now()
    rep = _replay_if_known(get_store(), account_id, when)
    known = {cid: st.level["id"] for cid, st in sorted(rep.concepts.items()) if st.active or st.xp > 0}
    return JSONResponse({"accountId": account_id, "levels": known})


@router.get("/refresher/{account_id}", response_model=None)
def refresher(account_id: str, now: str | None = Query(default=None)) -> Response:
    store = get_store()
    acct = _account_or_404(store, account_id)
    if isinstance(acct, JSONResponse):
        return acct
    try:
        when = _now(now)
    except ValueError:
        return _bad_now()
    pick = skills.pick_refresher(_replay(store, account_id, when), when)
    if pick is None:
        return Response(status_code=204)
    return JSONResponse({"accountId": account_id, **pick})


@router.get("/skills/in-demand")
def in_demand(
    account_id: str | None = Query(default=None, alias="accountId"), now: str | None = Query(default=None)
) -> JSONResponse:
    data = skills.in_demand_list()
    if account_id:
        store = get_store()
        if not store.get_account(account_id):
            return _error(404, "UNKNOWN_ACCOUNT", f"no local account {account_id!r}")
        try:
            when = _now(now)
        except ValueError:
            return _bad_now()
        rep = _replay(store, account_id, when)
        keep = {s["concept"] for s in skills.top_in_demand(rep)}
        data["skills"] = [s for s in data["skills"] if s["concept"] in keep]
    else:
        data["skills"] = data["skills"][:3]
    return JSONResponse(data)


@router.get("/matches/{account_id}")
def matches(account_id: str, now: str | None = Query(default=None)) -> JSONResponse:
    store = get_store()
    acct = _account_or_404(store, account_id)
    if isinstance(acct, JSONResponse):
        return acct
    try:
        when = _now(now)
    except ValueError:
        return _bad_now()
    others = [(a, _replay(store, a["accountId"], when)) for a in store.list_accounts()
              if a["accountId"] != account_id]
    return JSONResponse({"accountId": account_id,
                         "matches": matching.match(acct, _replay(store, account_id, when), others)})
