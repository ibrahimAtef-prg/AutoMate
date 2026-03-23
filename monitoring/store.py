import json
import logging as _logging
import math
import os
import tempfile
import time
import uuid

STORE_PATH = "monitoring_runs.json"
_log = _logging.getLogger(__name__)


def _sanitize(obj):
    """Recursively replace NaN and Infinity with None for safe JSON serialization."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def _load():
    if not os.path.exists(STORE_PATH):
        return []
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except Exception:
                _log.warning("monitoring store corrupted — resetting")
                return []
    except OSError as exc:
        _log.warning("monitoring store unreadable: %s — resetting", exc)
        return []


def _save(data):
    store_dir = os.path.dirname(os.path.abspath(STORE_PATH)) or "."
    fd, tmp_path = tempfile.mkstemp(dir=store_dir, suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(_sanitize(data), f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, STORE_PATH)
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise


def save_run(payload, mode: str = "system"):
    data = _load()

    if mode not in ("system", "agent"):
        mode = "system"

    payload = payload or {}
    analysis = payload.get("analysis", {}) if isinstance(payload, dict) else {}
    generated = payload.get("generate", {}) if isinstance(payload, dict) else {}

    record = {
        "id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "mode": mode,
        "decision": analysis.get("decision") if isinstance(analysis, dict) else None,
        "trust": analysis.get("trust") if isinstance(analysis, dict) else None,
        "summary": generated.get("summary") if isinstance(generated, dict) else None,
        "row_count": generated.get("row_count") if isinstance(generated, dict) else None,
    }

    data.append(record)
    _save(data)


def get_runs():
    return _load()
