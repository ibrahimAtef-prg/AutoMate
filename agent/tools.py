from __future__ import annotations

from typing import Any, Dict

from src.utils.baseline import build_baseline
from src.utils.generator import generate
from src.utils.leakage_bridge import run_leakage_analysis
from src.utils.parse import parse_dataset

_MAX_N = 1_000_000


def _to_jsonable(result: Any) -> Any:
    if hasattr(result, "to_dict") and callable(getattr(result, "to_dict")):
        return result.to_dict()
    return result


def _validate_n(args: Dict[str, Any]) -> int:
    n = args.get("n", 100)
    try:
        n = int(n)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Argument 'n' must be an integer, got {n!r}") from exc
    if n <= 0:
        raise ValueError(f"Argument 'n' must be a positive integer, got {n}")
    if n > _MAX_N:
        raise ValueError(
            f"Argument 'n' exceeds safe limit: {n} > {_MAX_N}"
        )
    return n


def _validate_file_path(args: Dict[str, Any]) -> str:
    path = args.get("file_path")
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Argument 'file_path' must be a non-empty string")
    return path


def _tool_parse(file_path: str, **_: Any) -> Any:
    return _to_jsonable(parse_dataset(file_path))


def _tool_baseline(file_path: str, **_: Any) -> Any:
    return _to_jsonable(build_baseline(file_path))


def _tool_generate(file_path: str, baseline_path: str, n: int = 100, **kwargs: Any) -> Any:
    return _to_jsonable(
        generate(
            dataset_path=file_path,
            baseline_path=baseline_path,
            n=int(n),
            cache_dir=kwargs.get("cache_dir"),
            seed=kwargs.get("seed"),
            label_distribution=kwargs.get("label_distribution"),
        )
    )


def _tool_analyze(file_path: str, n: int = 100, **kwargs: Any) -> Any:
    return run_leakage_analysis(
        file_path,
        n=int(n),
        pipeline_dir=kwargs.get("pipeline_dir"),
        seed=kwargs.get("seed"),
    )


class Tool:
    def __init__(self, name: str, fn, description: str):
        self.name = name
        self.fn = fn
        self.description = description

    def run(self, **kwargs) -> Dict[str, Any]:
        # Sanitize and bound n before dispatch
        if "n" in kwargs:
            kwargs["n"] = _validate_n(kwargs)
        # Ensure file_path is valid
        if "file_path" in kwargs:
            _validate_file_path(kwargs)
        return self.fn(**kwargs)


TOOLS = {
    "parse": Tool("parse", _tool_parse, "Parse dataset"),
    "baseline": Tool("baseline", _tool_baseline, "Build dataset profile"),
    "generate": Tool("generate", _tool_generate, "Generate synthetic data"),
    "analyze": Tool("analyze", _tool_analyze, "Run risk analysis"),
}
