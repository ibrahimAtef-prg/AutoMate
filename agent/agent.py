from __future__ import annotations

from typing import Any, Callable, Dict

from .executor import execute_plan
from .planner import build_plan


def run_agent(llm: Callable[[str], str], user_input: str, file_path: str) -> Dict[str, Any]:
    plan = build_plan(llm, user_input, file_path)
    execution = execute_plan(plan, file_path)

    return {
        "plan": plan,
        "execution": execution,
    }

