from __future__ import annotations

import json
import os
import platform
import signal
import tempfile
import time
from typing import Any, Dict, List

from .tools import TOOLS
from src.utils.baseline import build_baseline

MAX_STEPS = 8
MAX_ROWS = 1_000_000
MAX_TIME = 20

_USE_SIGNAL = platform.system() != "Windows"


class _TimeoutError(RuntimeError):
    pass


def _alarm_handler(signum, frame):
    raise _TimeoutError(f"Execution timeout: exceeded {MAX_TIME}s limit")


def execute_plan(plan: Dict[str, Any], file_path: str) -> List[Dict[str, Any]]:
    if not isinstance(plan, dict) or "steps" not in plan:
        raise ValueError("Plan must be an object with a 'steps' list")

    steps = plan["steps"]
    if not isinstance(steps, list):
        raise ValueError("Plan 'steps' must be a list")

    if len(steps) > MAX_STEPS:
        raise RuntimeError(
            f"Max steps exceeded: plan has {len(steps)} steps, limit is {MAX_STEPS}"
        )

    results: List[Dict[str, Any]] = []
    state: Dict[str, Any] = {
        "file_path": file_path,
        "last_result": None,
    }
    temp_files: List[str] = []
    history: set = set()

    if _USE_SIGNAL:
        signal.signal(signal.SIGALRM, _alarm_handler)
        signal.alarm(MAX_TIME)

    _wall_start = time.monotonic()

    try:
        for step in steps:
            if time.monotonic() - _wall_start > MAX_TIME:
                raise _TimeoutError(f"Execution timeout: exceeded {MAX_TIME}s limit")

            tool_name = step.get("tool")
            if not isinstance(tool_name, str) or not tool_name:
                raise ValueError(f"Step missing valid 'tool' field: {step!r}")

            args = dict(step.get("args") or {})

            if tool_name not in TOOLS:
                raise ValueError(f"Unknown tool: {tool_name!r}")

            tool = TOOLS[tool_name]

            args["file_path"] = state["file_path"]

            if "n" in args:
                try:
                    n_val = int(args["n"])
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        f"Argument 'n' must be an integer, got {args['n']!r}"
                    ) from exc
                if n_val > MAX_ROWS:
                    raise RuntimeError(
                        f"Requested rows exceed safe limit: n={n_val} > {MAX_ROWS}"
                    )
                args["n"] = n_val

            # Loop detection — key excludes file_path because it evolves legitimately
            loop_args = {k: v for k, v in args.items() if k != "file_path"}
            loop_key = (tool_name, json.dumps(loop_args, sort_keys=True, default=str))
            if loop_key in history:
                raise RuntimeError(
                    f"Execution loop detected: tool '{tool_name}' called with identical args more than once"
                )
            history.add(loop_key)

            baseline_tmp_path = None
            if tool_name == "generate" and not args.get("baseline_path"):
                baseline_obj = build_baseline(state["file_path"])
                baseline_dict = (
                    baseline_obj.to_dict()
                    if hasattr(baseline_obj, "to_dict")
                    else baseline_obj
                )
                tmp = tempfile.NamedTemporaryFile(
                    delete=False, suffix=".json", mode="w", encoding="utf-8"
                )
                with tmp as f:
                    json.dump(baseline_dict, f, ensure_ascii=False)
                baseline_tmp_path = tmp.name
                args["baseline_path"] = baseline_tmp_path

            try:
                result = tool.run(**args)
            except Exception as e:
                raise RuntimeError(f"Tool '{tool_name}' failed: {e}") from e
            finally:
                if baseline_tmp_path:
                    try:
                        os.remove(baseline_tmp_path)
                    except Exception:
                        pass

            state["last_result"] = result

            if isinstance(result, dict):
                if tool_name == "generate":
                    next_file_path = result.get("file_path")
                    if not isinstance(next_file_path, str) or not next_file_path:
                        samples = result.get("samples")
                        if not isinstance(samples, list):
                            raise RuntimeError(
                                "Generate step did not return samples for downstream analyze"
                            )
                        generated_tmp = tempfile.NamedTemporaryFile(
                            delete=False, suffix=".json", mode="w", encoding="utf-8"
                        )
                        with generated_tmp as f:
                            json.dump(samples, f, ensure_ascii=False)
                        next_file_path = generated_tmp.name
                        temp_files.append(next_file_path)
                        result["file_path"] = next_file_path
                    state["file_path"] = next_file_path
                elif (
                    "file_path" in result
                    and isinstance(result.get("file_path"), str)
                    and result.get("file_path")
                ):
                    state["file_path"] = result["file_path"]

            results.append({"tool": tool_name, "result": result})

    finally:
        if _USE_SIGNAL:
            signal.alarm(0)
        for temp_path in temp_files:
            try:
                os.remove(temp_path)
            except Exception:
                pass

    return results
