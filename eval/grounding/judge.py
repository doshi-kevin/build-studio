"""Layer 2, step 2 — the LLM-judged half of the grounding eval (§11).

Reads `records.jsonl` (written by export.ts, which ran the real retrieval and
the real prompt), scores each answer with RAGAS, prints the table against the
committed baseline, and writes its numbers back into `baseline.json` when asked.

    eval/grounding/.venv/bin/python eval/grounding/judge.py
    … --update-baseline

**This never fails a run.** Faithfulness and relevancy come from a model
grading a model; identical inputs move a couple of points between runs, so a
gate here would train everyone to re-run until green. The deterministic
citation checks in export.ts are the gate; these numbers are the reading.

Metrics
-------
faithfulness       share of the answer's claims entailed by the pages it was
                   given — the production citation-verifier's question (§2 box 5)
                   asked offline. The headline number: a drop means Athena is
                   saying things her sources don't support.
answer_relevancy   does the answer actually address the question — catches
                   grounded-but-evasive. Needs an embedding model; skipped
                   automatically when the judge provider has none.
refusal_compliance our own metric, not RAGAS's: for an out-of-corpus question,
                   did the answer decline instead of explaining the concept
                   anyway (G1)? Judged, because "did it refuse" is a question
                   about prose. Its deterministic twin — did it invent a
                   citation — is gated in export.ts.

Switching judges
----------------
Nothing here is Gemini-specific. The judge is built from env, and every
OpenAI-compatible provider goes through one code path:

    EVAL_JUDGE_PROVIDER=google      # default; reuses GOOGLE_GENERATIVE_AI_API_KEY
    EVAL_JUDGE_PROVIDER=openai      # OPENAI_API_KEY
    EVAL_JUDGE_PROVIDER=anthropic   # ANTHROPIC_API_KEY (pip install anthropic)
    EVAL_JUDGE_PROVIDER=custom      # any OpenAI-compatible gateway
    EVAL_JUDGE_BASE_URL=...         # required for custom
    EVAL_JUDGE_MODEL=...            # overrides the provider default
    EVAL_JUDGE_API_KEY=...          # overrides the provider's usual key var
    EVAL_JUDGE_EMBEDDINGS=none      # drop answer_relevancy

A changed judge changes the numbers, so record a fresh baseline when you switch
— and note which judge produced it (the baseline stores the provider + model).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
RECORDS_PATH = HERE / "records.jsonl"
BASELINE_PATH = HERE / "baseline.json"

# Concurrent judged samples. Faithfulness is 2+ calls per sample over a ~10-page
# context, so this is the knob that decides whether a run takes 1 minute or 5.
CONCURRENCY = 4

# Room for the judge's own structured output. See where it's used — the default
# is far too small for a reasoning model doing claim-by-claim entailment.
JUDGE_MAX_TOKENS = 16384

# Google exposes an OpenAI-compatible surface, which is what lets one client type
# serve every provider here — and what makes swapping the judge a key change.
GOOGLE_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
ANTHROPIC_OPENAI_BASE = "https://api.anthropic.com/v1/"

PROVIDER_DEFAULTS: dict[str, dict[str, str | None]] = {
    "google": {
        "base_url": GOOGLE_OPENAI_BASE,
        "key_env": "GOOGLE_GENERATIVE_AI_API_KEY",
        "model": "gemini-3-flash-preview",
        "embeddings": "gemini-embedding-001",
    },
    "openai": {
        "base_url": None,  # the SDK's own default
        "key_env": "OPENAI_API_KEY",
        "model": "gpt-4o-mini",
        "embeddings": "text-embedding-3-small",
    },
    "anthropic": {
        "base_url": ANTHROPIC_OPENAI_BASE,
        "key_env": "ANTHROPIC_API_KEY",
        "model": "claude-haiku-4-5-20251001",
        # Anthropic ships no embedding model. answer_relevancy is skipped unless
        # EVAL_JUDGE_EMBEDDINGS names one reachable from this base_url.
        "embeddings": None,
    },
    "custom": {
        "base_url": None,  # must come from EVAL_JUDGE_BASE_URL
        "key_env": "EVAL_JUDGE_API_KEY",
        "model": None,
        "embeddings": None,
    },
}


@dataclass
class JudgeConfig:
    provider: str
    model: str
    base_url: str | None
    api_key: str
    embeddings: str | None
    """Reasoning budget for the judge, or None to leave the provider's default.

    Judging is extraction and entailment, not reasoning, and a thinking judge
    spends its token budget BEFORE emitting the structured verdict — which showed
    up as half the run failing with "output is incomplete due to a max_tokens
    length limit", stochastically, on the longest answers. Turning it off costs
    ~0.015 of faithfulness on a control and makes the run reliable and cheaper.
    Only sent when set, because it is not a universal parameter.
    """
    reasoning: str | None

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}"


def load_config() -> JudgeConfig:
    provider = os.environ.get("EVAL_JUDGE_PROVIDER", "google").strip().lower()
    if provider not in PROVIDER_DEFAULTS:
        raise SystemExit(
            f"EVAL_JUDGE_PROVIDER={provider!r} is not one of: {', '.join(PROVIDER_DEFAULTS)}"
        )
    defaults = PROVIDER_DEFAULTS[provider]

    model = os.environ.get("EVAL_JUDGE_MODEL") or defaults["model"]
    if not model:
        raise SystemExit(f"set EVAL_JUDGE_MODEL — provider {provider!r} has no default model")

    base_url = os.environ.get("EVAL_JUDGE_BASE_URL") or defaults["base_url"]
    if provider == "custom" and not base_url:
        raise SystemExit("EVAL_JUDGE_PROVIDER=custom needs EVAL_JUDGE_BASE_URL")

    key_env = str(defaults["key_env"])
    api_key = os.environ.get("EVAL_JUDGE_API_KEY") or os.environ.get(key_env) or ""
    if not api_key:
        raise SystemExit(
            f"no judge API key — set EVAL_JUDGE_API_KEY or {key_env} in the environment "
            f"(npm run eval:grounding loads .env.local for you)"
        )

    embeddings = os.environ.get("EVAL_JUDGE_EMBEDDINGS") or defaults["embeddings"]
    if embeddings and embeddings.strip().lower() == "none":
        embeddings = None

    # Default off for Google (its flash models think by default); left alone for
    # every other provider, where the parameter may not exist at all.
    # "low", not "none": at none the judge mis-scored a perfectly grounded answer
    # (0.20 on a case whose every bullet is verbatim on the cited page); low
    # recovered it to 0.50 at no truncation cost. Neither is right — see the
    # non-factual-sentence caveat in eval/README.md — which is the evidence that
    # this number is a report and not a gate.
    reasoning = os.environ.get("EVAL_JUDGE_REASONING") or ("low" if provider == "google" else "")
    return JudgeConfig(provider, model, base_url, api_key, embeddings, reasoning.strip() or None)


def load_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"no records at {path} — run `npm run eval:grounding` first")
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not records:
        raise SystemExit(f"{path} is empty")
    return records


# ── The refusal metric ────────────────────────────────────────────────────────
# Not a RAGAS metric: "did this answer decline, or did it teach the topic
# anyway" is a yes/no about prose, and the failure it catches (G1) is the single
# worst thing this feature can do — answer an out-of-corpus question from the
# model's own knowledge as if it came from the course.

REFUSAL_PROMPT = """You are auditing a course assistant that must only answer from a specific course's materials.

The student asked a question the course does NOT cover. The assistant was given no relevant material.

QUESTION: {question}

ASSISTANT'S ANSWER:
{answer}

Did the assistant correctly DECLINE — telling the student the topic isn't in this course's materials, without teaching the topic itself?

Answer "yes" if it declined. Offering a related course topic, or a one-line orientation of what the topic belongs to, still counts as declining.
Answer "no" if it explained the concept, gave a definition, worked an example, or otherwise answered the question as asked.

Reply with exactly one word: yes or no."""


async def judge_refusal(
    client: Any, model: str, question: str, answer: str, reasoning: str | None
) -> float:
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": REFUSAL_PROMPT.format(question=question, answer=answer)}],
        temperature=0,
        max_tokens=JUDGE_MAX_TOKENS,
        **({"reasoning_effort": reasoning} if reasoning else {}),
    )
    verdict = (resp.choices[0].message.content or "").strip().lower()
    return 1.0 if verdict.startswith("yes") else 0.0


async def score_all(records: list[dict[str, Any]], cfg: JudgeConfig) -> tuple[list[dict[str, Any]], list[str]]:
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory
    from ragas.metrics.collections import AnswerRelevancy, Faithfulness

    notes: list[str] = []
    client = AsyncOpenAI(api_key=cfg.api_key, **({"base_url": cfg.base_url} if cfg.base_url else {}))
    # max_tokens is load-bearing, not a default worth inheriting: the judge
    # returns STRUCTURED output, and a reasoning model spends its budget thinking
    # before it emits any — at the library default every single sample failed with
    # "output is incomplete due to a max_tokens length limit". Faithfulness also
    # scales with the answer: one verdict per extracted claim, so a long grounded
    # answer needs room for a dozen.
    extra = {"reasoning_effort": cfg.reasoning} if cfg.reasoning else {}
    llm = llm_factory(cfg.model, provider="openai", client=client, max_tokens=JUDGE_MAX_TOKENS, **extra)

    faithfulness = Faithfulness(llm=llm)
    relevancy = None
    if cfg.embeddings:
        from ragas.embeddings.base import embedding_factory

        relevancy = AnswerRelevancy(
            llm=llm,
            embeddings=embedding_factory(
                provider="openai", model=cfg.embeddings, client=client, interface="modern"
            ),
        )
    else:
        notes.append(
            f"answer_relevancy skipped — provider {cfg.provider!r} has no embedding model configured "
            f"(set EVAL_JUDGE_EMBEDDINGS to enable it)"
        )

    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def score_one(rec: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            out: dict[str, Any] = {"id": rec["id"], "expected": rec["expected_behavior"]}
            question, answer = rec["question"], rec["answer"]
            contexts = rec.get("contexts") or []

            if rec["expected_behavior"] == "refuse":
                # Nothing to be faithful TO — the context is empty by design.
                # The only question worth asking is whether it declined.
                try:
                    out["refusal_compliance"] = await judge_refusal(
                        client, cfg.model, question, answer, cfg.reasoning
                    )
                except Exception as err:  # noqa: BLE001 — one bad sample must not sink the run
                    out["error"] = f"refusal judge: {err}"
                return out

            if rec.get("finish_reason") == "tool-calls" and not answer:
                # The model reached for a tool this harness doesn't pass — an eval
                # limitation, already reported by export.ts. Judging "" would
                # record a zero for a turn that answers fine in production.
                out["skipped"] = "ended in a tool call"
                return out

            if not contexts:
                # An answer case whose retrieval came back empty is a layer-1
                # failure already reported there; scoring it here would report
                # the same miss twice under a different name.
                out["skipped"] = "no retrieved context"
                return out

            try:
                res = await faithfulness.ascore(
                    user_input=question, response=answer, retrieved_contexts=contexts
                )
                out["faithfulness"] = float(res.value)
            except Exception as err:  # noqa: BLE001
                out["error"] = f"faithfulness: {err}"

            if relevancy is not None:
                try:
                    # No contexts: relevancy asks whether the ANSWER addresses the
                    # QUESTION, by generating questions from the answer and
                    # comparing them to the real one. Faithfulness is the metric
                    # that looks at the pages.
                    res = await relevancy.ascore(user_input=question, response=answer)
                    out["answer_relevancy"] = float(res.value)
                except Exception as err:  # noqa: BLE001
                    out["error"] = f"{out.get('error', '')} relevancy: {err}".strip()
            return out

    scored = await asyncio.gather(*(score_one(r) for r in records))
    return list(scored), notes


def mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def aggregate(scored: list[dict[str, Any]]) -> dict[str, float]:
    agg: dict[str, float] = {}
    for key in ("faithfulness", "answer_relevancy", "refusal_compliance"):
        values = [s[key] for s in scored if isinstance(s.get(key), float)]
        if values:
            agg[key] = mean(values)
    return agg


def main() -> int:
    args = sys.argv[1:]
    update_baseline = "--update-baseline" in args
    # export.ts passes the file it just wrote — a `--case=` run writes a
    # one-record file, and judging the full set instead would report numbers for
    # answers this run never produced.
    positional = [a for a in args if not a.startswith("--")]
    records_path = Path(positional[0]) if positional else RECORDS_PATH
    cfg = load_config()
    records = load_records(records_path)

    print(
        f"judge {cfg.label}"
        + (f" via {cfg.base_url}" if cfg.base_url else "")
        + (f" · reasoning {cfg.reasoning}" if cfg.reasoning else "")
    )
    print(f"scoring {len(records)} records" + (f" · embeddings {cfg.embeddings}" if cfg.embeddings else ""))

    scored, notes = asyncio.run(score_all(records, cfg))
    agg = aggregate(scored)

    print("\nper case (judged)")
    print("─" * 96)
    for s in scored:
        if s.get("skipped"):
            print(f"  – {s['id']:<32} skipped — {s['skipped']}")
            continue
        if s.get("error") and not any(isinstance(s.get(k), float) for k in ("faithfulness", "refusal_compliance")):
            print(f"  ! {s['id']:<32} {s['error']}")
            continue
        if s["expected"] == "refuse":
            ok = s.get("refusal_compliance", 0.0) == 1.0
            print(f"  {'✓' if ok else '✗'} {s['id']:<32} refusal {'held' if ok else 'ANSWERED ANYWAY'}")
        else:
            bits = [f"faith {s['faithfulness']:.2f}"] if "faithfulness" in s else []
            if "answer_relevancy" in s:
                bits.append(f"rel {s['answer_relevancy']:.2f}")
            print(f"  · {s['id']:<32} {'  '.join(bits)}")
    print("─" * 96)

    baseline: dict[str, Any] = {}
    if BASELINE_PATH.exists():
        baseline = json.loads(BASELINE_PATH.read_text())
    was = baseline.get("judged", {}) or {}

    for key, value in agg.items():
        prior = was.get(key)
        if isinstance(prior, (int, float)):
            delta = value - prior
            arrow = "→" if abs(delta) < 0.005 else ("↑" if delta > 0 else "↓")
            print(f"  {key:<20} {value:.4f}   {arrow} baseline {prior:.4f} ({delta:+.4f})")
        else:
            print(f"  {key:<20} {value:.4f}   (no baseline)")

    for note in notes:
        print(f"\n  note: {note}")

    # Judged numbers never fail the run — see this module's docstring. Say so out
    # loud, so a red-looking delta isn't mistaken for a broken build.
    worse = [k for k, v in agg.items() if isinstance(was.get(k), (int, float)) and v < was[k] - 0.05]
    if worse:
        print(
            f"\n⚠️  judged metrics down more than 0.05: {', '.join(worse)}.\n"
            f"    LLM judging is noisy — re-run before believing it, then read the per-case lines above."
        )

    if update_baseline:
        if records_path != RECORDS_PATH:
            print("\nrefusing to record a judged baseline from a single-case run")
            return 0
        baseline["judged"] = agg
        baseline["judge"] = cfg.label
        BASELINE_PATH.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"\njudged baseline updated → eval/grounding/baseline.json (judge {cfg.label})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
