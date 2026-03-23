from __future__ import annotations

import json
from typing import Any, Callable, Dict

from .schema import Plan
from .tools import TOOLS


SYSTEM_PROMPT = """
You are an execution planner.

You MUST output ONLY valid JSON.
No explanation.
No text.

Available tools:
- parse(file_path)
- baseline(file_path)
- generate(file_path, baseline_path, n)
- analyze(file_path, n)

Rules:
- Break tasks into steps
- Use multiple steps if needed
- Always return JSON:
{ "steps": [ { "tool": "...", "args": {...} } ] }
"""

_LLM_OUTPUT_MAX_BYTES = 100_000


def _validate_plan(payload: Dict[str, Any]) -> Plan:
    if not isinstance(payload, dict):
        raise ValueError("Plan must be a JSON object")

    if "steps" not in payload or not isinstance(payload["steps"], list):
        raise ValueError("Plan must include a 'steps' list")

    for i, step in enumerate(payload["steps"]):
        if not isinstance(step, dict):
            raise ValueError(f"Step {i} must be an object")

        tool_name = step.get("tool")
        if not isinstance(tool_name, str) or not tool_name.strip():
            raise ValueError(f"Step {i} is missing a valid 'tool'")

        if tool_name not in TOOLS:
            raise ValueError(f"Step {i} uses unknown tool: {tool_name!r}")

        args = step.get("args", {})
        if args is None:
            args = {}
            step["args"] = args
        if not isinstance(args, dict):
            raise ValueError(f"Step {i} must provide 'args' as an object")

    if hasattr(Plan, "model_validate"):
        return Plan.model_validate(payload)
    return Plan.parse_obj(payload)


def _dump_plan(plan: Plan) -> Dict[str, Any]:
    if hasattr(plan, "model_dump"):
        return plan.model_dump()
    return plan.dict()


def build_plan(llm: Callable[[str], str], user_input: str, file_path: str) -> Dict[str, Any]:
    if not callable(llm):
        raise ValueError("llm must be callable")

    prompt = SYSTEM_PROMPT + f"\nUser request: {user_input}\nDataset path: {file_path}"
    raw = llm(prompt)

    if not isinstance(raw, str):
        raise ValueError("LLM planner must return JSON text")

    if len(raw) > _LLM_OUTPUT_MAX_BYTES:
        raise ValueError(
            f"LLM output too large: {len(raw)} bytes exceeds limit of {_LLM_OUTPUT_MAX_BYTES}"
        )

    raw = raw.strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM did not return valid JSON: {exc}") from exc

    plan = _validate_plan(parsed)
    return _dump_plan(plan)
