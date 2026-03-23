from __future__ import annotations

import json
import math
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from threading import Lock
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from src.utils.parse import parse_dataset
from src.utils.baseline import build_baseline
from src.utils.generator import generate
from src.utils.leakage_bridge import run_leakage_analysis
from monitoring.store import save_run, get_runs
from monitoring.insights import build_insights

app = FastAPI(title="AutoMate API", version="1.0.0")

_rate_lock = Lock()
_last_call: float = 0.0
RATE_LIMIT_SECONDS: float = 1.0
MAX_FILE_BYTES: int = 10_000_000
ALLOWED_EXTENSIONS = {".csv", ".json", ".parquet"}


# ── Structured error helper ──────────────────────────────────────────────────

def _err(type_: str, message: str, details: Any = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"type": type_, "message": message}
    if details is not None:
        payload["details"] = details
    return {"error": payload}


# ── Guards ───────────────────────────────────────────────────────────────────

def _rate_check() -> None:
    global _last_call
    with _rate_lock:
        now = time.time()
        if now - _last_call < RATE_LIMIT_SECONDS:
            raise HTTPException(
                status_code=429,
                detail=_err("RateLimitExceeded", "Too many requests — wait before retrying"),
            )
        _last_call = now


def _ext_check(upload: UploadFile) -> str:
    filename = upload.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=_err(
                "UnsupportedMediaType",
                f"File type '{ext or '(none)'}' is not allowed. "
                f"Accepted: {sorted(ALLOWED_EXTENSIONS)}",
            ),
        )
    return ext


def _save_temp_file(upload: UploadFile) -> str:
    ext = _ext_check(upload)

    # Pre-copy size check when .size is available
    size = getattr(upload, "size", None)
    if size is not None and size > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=_err(
                "PayloadTooLarge",
                f"File too large: {size} bytes (limit {MAX_FILE_BYTES})",
            ),
        )

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        with tmp as buffer:
            shutil.copyfileobj(upload.file, buffer)
    except Exception as exc:
        try:
            os.remove(tmp.name)
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail=_err("UploadError", f"Failed to save upload: {exc}"),
        ) from exc

    # Post-copy size check (covers multipart where .size is absent)
    actual_size = os.path.getsize(tmp.name)
    if actual_size > MAX_FILE_BYTES:
        try:
            os.remove(tmp.name)
        except Exception:
            pass
        raise HTTPException(
            status_code=413,
            detail=_err(
                "PayloadTooLarge",
                f"File too large: {actual_size} bytes (limit {MAX_FILE_BYTES})",
            ),
        )

    return tmp.name


def _cleanup(path: Optional[str]) -> None:
    if not path:
        return
    try:
        os.remove(path)
    except Exception:
        pass


def _to_jsonable(result: Any) -> Any:
    if hasattr(result, "to_dict") and callable(getattr(result, "to_dict")):
        return result.to_dict()
    return result


def _write_json_temp(payload: Any, suffix: str = ".json") -> str:
    tmp = tempfile.NamedTemporaryFile(
        delete=False, suffix=suffix, mode="w", encoding="utf-8"
    )
    with tmp as f:
        json.dump(payload, f, ensure_ascii=False)
    return tmp.name


def _prepare_baseline_file(dataset_path: str) -> str:
    baseline_obj = build_baseline(dataset_path)
    baseline_dict: Dict[str, Any] = _to_jsonable(baseline_obj)
    return _write_json_temp(baseline_dict)


def _extract_agent_monitor_payload(execution: Any) -> Dict[str, Any]:
    analysis_block: Dict[str, Any] = {"decision": None, "trust": None}
    generate_block: Dict[str, Any] = {"summary": None, "row_count": None}

    if isinstance(execution, list):
        for step in execution:
            if not isinstance(step, dict):
                continue
            tool_name = step.get("tool")
            tool_result = step.get("result")
            if not isinstance(tool_result, dict):
                continue

            if tool_name == "analyze":
                analysis_block["decision"] = tool_result.get("decision")
                analysis_block["trust"] = tool_result.get("trust")
            elif tool_name == "generate":
                generate_block["summary"] = tool_result.get("summary")
                generate_block["row_count"] = tool_result.get("row_count")

    return {"analysis": analysis_block, "generate": generate_block}


def _agent_llm(prompt: str) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY")
    model = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required for /agent endpoint")

    payload = {
        "model": model,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = (
            exc.read().decode("utf-8", errors="ignore")
            if hasattr(exc, "read")
            else str(exc)
        )
        raise RuntimeError(f"LLM request failed: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"LLM request failed: {exc}") from exc

    try:
        parsed = json.loads(body)
        content = (
            (((parsed or {}).get("choices") or [{}])[0].get("message") or {}).get(
                "content"
            )
        )
    except Exception as exc:
        raise RuntimeError("LLM response parse failed") from exc

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("LLM returned empty planning content")

    return content.strip()


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/parse")
def parse(file: UploadFile = File(...)):
    _rate_check()
    path = _save_temp_file(file)
    try:
        result = parse_dataset(path)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        _cleanup(path)


@app.post("/baseline")
def baseline(file: UploadFile = File(...)):
    _rate_check()
    path = _save_temp_file(file)
    try:
        result = build_baseline(path)
        return _to_jsonable(result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        _cleanup(path)


@app.post("/generate")
def gen(file: UploadFile = File(...), n: int = 100):
    _rate_check()
    path = _save_temp_file(file)
    baseline_path: Optional[str] = None
    try:
        baseline_path = _prepare_baseline_file(path)
        result = generate(path, baseline_path=baseline_path, n=n)
        return _to_jsonable(result)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        _cleanup(baseline_path)
        _cleanup(path)


@app.post("/analyze")
def analyze(file: UploadFile = File(...), n: int = 100):
    _rate_check()
    path = _save_temp_file(file)
    try:
        result = run_leakage_analysis(path, n=n)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        _cleanup(path)


@app.post("/full")
def full_pipeline(file: UploadFile = File(...), n: int = 100):
    _rate_check()
    path = _save_temp_file(file)
    baseline_path: Optional[str] = None
    analysis_source_path: Optional[str] = None

    try:
        parsed = parse_dataset(path)
        baseline_obj = build_baseline(path)
        baseline = _to_jsonable(baseline_obj)

        baseline_path = _write_json_temp(baseline)

        generated = _to_jsonable(generate(path, baseline_path=baseline_path, n=n))

        analysis_source_path = path
        if isinstance(generated, dict):
            samples = generated.get("samples")
            if isinstance(samples, list):
                analysis_source_path = _write_json_temp(samples)

        analysis_raw = run_leakage_analysis(analysis_source_path, n=n)
        analysis = {
            "decision": (analysis_raw or {}).get("decision"),
            "trust": (analysis_raw or {}).get("trust"),
        }

        if analysis["decision"] is None or analysis["trust"] is None:
            raise HTTPException(
                status_code=500,
                detail=_err(
                    "ContractViolation",
                    "Analysis contract violation: missing decision or trust",
                ),
            )

        result = {
            "mode": "system",
            "parse": parsed,
            "baseline": baseline,
            "generate": generated,
            "analysis": analysis,
        }

        save_run(result, mode="system")
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        if analysis_source_path and analysis_source_path != path:
            _cleanup(analysis_source_path)
        _cleanup(baseline_path)
        _cleanup(path)


@app.post("/agent")
def agent(file: UploadFile = File(...), query: str = ""):
    _rate_check()
    path = _save_temp_file(file)

    try:
        if not query.strip():
            raise HTTPException(
                status_code=400,
                detail=_err("ValidationError", "query is required"),
            )

        from agent.agent import run_agent

        raw_result = run_agent(_agent_llm, query, path)
        if not isinstance(raw_result, dict):
            raise HTTPException(
                status_code=500,
                detail=_err("ContractViolation", "Agent result is not an object"),
            )

        plan = raw_result.get("plan")
        execution = raw_result.get("execution")
        if not isinstance(plan, dict) or not isinstance(execution, list):
            raise HTTPException(
                status_code=500,
                detail=_err(
                    "ContractViolation",
                    "Agent contract violation: missing plan or execution",
                ),
            )

        result = {"plan": plan, "execution": execution, "mode": "agent"}

        monitor_payload = {
            "mode": "agent",
            **_extract_agent_monitor_payload(execution),
        }
        save_run(monitor_payload, mode="agent")
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=_err(type(e).__name__, str(e))
        )
    finally:
        _cleanup(path)


@app.get("/runs")
def runs():
    return get_runs()


@app.get("/insights")
def insights():
    return build_insights()


@app.exception_handler(Exception)
def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content=_err(exc.__class__.__name__, str(exc)),
    )
