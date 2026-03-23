from .store import get_runs


def build_insights():
    runs = get_runs()
    if not runs:
        return {
            "total_runs": 0,
            "distribution": {
                "critical": 0,
                "warning": 0,
                "safe": 0,
            },
            "avg_rows": 0.0,
        }

    total = len(runs)

    def _level(record):
        decision = record.get("decision") or {}
        decisions = decision.get("decisions") or [{}]
        top = decisions[0] if decisions else {}
        return top.get("level")

    critical = sum(
        1
        for r in runs
        if _level(r) == "critical"
    )
    warning = sum(
        1
        for r in runs
        if _level(r) == "warning"
    )
    safe = sum(
        1
        for r in runs
        if _level(r) == "safe"
    )

    avg_rows = sum((r.get("row_count") or 0) for r in runs) / total

    return {
        "total_runs": total,
        "distribution": {
            "critical": critical,
            "warning": warning,
            "safe": safe,
        },
        "avg_rows": round(avg_rows, 2),
    }

