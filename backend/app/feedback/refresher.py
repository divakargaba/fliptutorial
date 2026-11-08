"""Generate a refresher question for a weak concept using Claude.

Called by B1's profile lane when no stored refresher is available. The function
produces one short multiple-choice question pitched at the learner's level.

Return shape matches what B1 expects:
  {title, prompt, choices: [{id, text}], answer, explanation} | None
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger("breakpoint.feedback.refresher")

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = "claude-haiku-5-5"
BUDGET_S = 15.0

REFRESHER_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": "Short title for the question, 3-8 words.",
        },
        "prompt": {
            "type": "string",
            "description": "The question text. One or two sentences, possibly with a code snippet in backticks.",
        },
        "choices": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Choice letter: a, b, c, d, e, or f."},
                    "text": {"type": "string", "description": "The choice text."},
                },
                "required": ["id", "text"],
                "additionalProperties": False,  # structured output rejects nested objects without it
            },
            "description": "2-6 unique answer choices.",
        },
        "answer": {
            "type": "string",
            "description": "The id of the correct choice (e.g. 'a').",
        },
        "explanation": {
            "type": "string",
            "description": "1-2 sentence explanation of why the answer is correct.",
        },
    },
    "required": ["title", "prompt", "choices", "answer", "explanation"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You write one short multiple-choice refresher question to test a learner's understanding of a programming concept.

Rules:
- The question tests conceptual understanding, not trivia.
- Write exactly 2-6 unique choices. Each choice must have a unique id (a, b, c, ...) and unique text.
- The answer field is the id of the correct choice.
- Pitch difficulty to the learner's level: beginner questions test basic recall and simple examples; intermediate questions require applying the concept; advanced/expert questions test edge cases and deeper understanding.
- Keep the prompt concise (1-2 sentences, optionally with a short code snippet in backticks).
- The explanation should teach, not just restate the answer.
- Do not repeat questions whose prompts are listed in the "avoid" section."""

_LOCK = threading.Lock()
_failure_backoff_until: float = 0.0
_BACKOFF_S = 600.0  # 10 minutes


def _tier_label(level_id: str) -> str:
    """'beginner-3' -> 'beginner'."""
    return level_id.rsplit("-", 1)[0] if "-" in level_id else level_id


def _build_prompt(concept_id: str, concept_name: str, level_id: str, avoid_prompts: list[str]) -> str:
    tier = _tier_label(level_id)
    parts = [
        f"Concept: {concept_name} (id: {concept_id})",
        f"Learner level: {level_id} (tier: {tier})",
    ]
    if avoid_prompts:
        parts.append("Avoid repeating these prompts:")
        for p in avoid_prompts[:10]:
            parts.append(f"  - {p[:200]}")
    return "\n".join(parts)


def _validate(data: dict) -> dict | None:
    """Validate the generated question. Returns cleaned data or None."""
    title = (data.get("title") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    choices = data.get("choices")
    answer = (data.get("answer") or "").strip()
    explanation = (data.get("explanation") or "").strip()

    if not title or not prompt or not explanation:
        return None
    if not isinstance(choices, list) or len(choices) < 2 or len(choices) > 6:
        return None

    # Validate choices: unique ids, unique texts
    seen_ids: set[str] = set()
    seen_texts: set[str] = set()
    clean_choices = []
    for c in choices:
        if not isinstance(c, dict):
            return None
        cid = (c.get("id") or "").strip()
        ctext = (c.get("text") or "").strip()
        if not cid or not ctext:
            return None
        if cid in seen_ids or ctext.lower() in seen_texts:
            return None
        seen_ids.add(cid)
        seen_texts.add(ctext.lower())
        clean_choices.append({"id": cid, "text": ctext})

    # Answer must be one of the choice ids
    if answer not in seen_ids:
        return None

    # Length limits
    if len(title) > 100 or len(prompt) > 500 or len(explanation) > 500:
        return None
    if any(len(c["text"]) > 300 for c in clean_choices):
        return None

    return {
        "title": title,
        "prompt": prompt,
        "choices": clean_choices,
        "answer": answer,
        "explanation": explanation,
    }


async def generate_refresher(
    concept_id: str,
    concept_name: str,
    level_id: str,
    avoid_prompts: list[str] | None = None,
) -> dict | None:
    """Generate one refresher question using Claude.

    Returns {title, prompt, choices: [{id, text}], answer, explanation} or None
    if the model is unavailable, the key is missing, or generation is disabled.
    """
    # Feature gate
    if os.environ.get("BREAKPOINT_REFRESHER_GENERATE", "1") == "0":
        return None

    # Back-off after a recent failure
    import time
    with _LOCK:
        global _failure_backoff_until
        if time.monotonic() < _failure_backoff_until:
            logger.debug("refresher generation in back-off period")
            return None

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.debug("ANTHROPIC_API_KEY not set; skipping refresher generation")
        return None

    model = os.environ.get("ANTHROPIC_REFRESHER_MODEL") or DEFAULT_MODEL
    user_prompt = _build_prompt(concept_id, concept_name, level_id, avoid_prompts or [])

    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=1, timeout=BUDGET_S)
        resp = await asyncio.wait_for(
            client.beta.messages.create(
                model=model,
                max_tokens=2000,
                system=[{"type": "text", "text": SYSTEM_PROMPT}],
                messages=[{"role": "user", "content": user_prompt}],
                output_config={
                    "effort": "low",
                    "format": {"type": "json_schema", "schema": REFRESHER_SCHEMA},
                },
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default"},
            ),
            BUDGET_S + 1,
        )

        if resp.stop_reason in ("refusal", "max_tokens"):
            raise RuntimeError(f"model stopped: {resp.stop_reason}")

        raw = "".join(b.text for b in resp.content if b.type == "text")
        data = json.loads(raw)
        result = _validate(data)
        if result is None:
            logger.info("refresher generation produced invalid output")
            return None

        return result

    except Exception as exc:
        logger.info("refresher generation failed: %s: %s", type(exc).__name__, exc)
        with _LOCK:
            _failure_backoff_until = time.monotonic() + _BACKOFF_S
        return None
