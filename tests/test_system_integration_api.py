from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from fastapi.testclient import TestClient

import api
import monitoring.store as monitoring_store
from agent.tools import TOOLS


DATASET_PATH = Path("test_data/sample_valid.csv")


def _post_file(client: TestClient, endpoint: str, params: Dict[str, Any]):
    with DATASET_PATH.open("rb") as f:
        return client.post(
            endpoint,
            files={"file": (DATASET_PATH.name, f, "text/csv")},
            params=params,
        )


def test_full_contract_and_monitoring(monkeypatch, tmp_path):
    monkeypatch.setattr(monitoring_store, "STORE_PATH", str(tmp_path / "monitoring_runs.json"))

    client = TestClient(api.app)
    response = _post_file(client, "/full", {"n": 20})

    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"parse", "baseline", "generate", "analysis", "mode"}
    assert body["mode"] == "system"
    assert isinstance(body["analysis"], dict)
    assert set(body["analysis"].keys()) == {"decision", "trust"}
    assert body["analysis"]["decision"] is not None
    assert body["analysis"]["trust"] is not None

    runs = monitoring_store.get_runs()
    assert len(runs) == 1
    run = runs[0]
    for field in ("mode", "decision", "trust", "row_count", "summary"):
        assert field in run
    assert run["mode"] == "system"


def test_agent_generate_then_analyze_uses_generated_dataset(monkeypatch, tmp_path):
    monkeypatch.setattr(monitoring_store, "STORE_PATH", str(tmp_path / "monitoring_runs.json"))
    monkeypatch.setattr(
        api,
        "_agent_llm",
        lambda _prompt: '{"steps":[{"tool":"generate","args":{"n":100}},{"tool":"analyze","args":{"n":100}}]}',
    )

    captured: Dict[str, Any] = {}

    def fake_generate(file_path: str, baseline_path: str, n: int = 100, **_: Any):
        return {
            "samples": [{"x": 1}, {"x": 2}],
            "row_count": int(n),
            "summary": "generated",
        }

    def fake_analyze(file_path: str, n: int = 100, **_: Any):
        captured["analyze_file_path"] = file_path
        return {
            "decision": {"decisions": [{"level": "safe", "message": "ok", "action": "none"}]},
            "trust": {"trust_score": 1.0, "trust_level": "high"},
        }

    monkeypatch.setattr(TOOLS["generate"], "fn", fake_generate)
    monkeypatch.setattr(TOOLS["analyze"], "fn", fake_analyze)

    client = TestClient(api.app)
    response = _post_file(client, "/agent", {"query": "generate 100 rows then analyze"})

    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"plan", "execution", "mode"}
    assert body["mode"] == "agent"
    assert isinstance(body["plan"], dict)
    assert isinstance(body["execution"], list)
    assert [step.get("tool") for step in body["execution"]] == ["generate", "analyze"]

    analyze_file_path = str(captured.get("analyze_file_path") or "")
    assert analyze_file_path.endswith(".json")

    runs = monitoring_store.get_runs()
    assert len(runs) == 1
    run = runs[0]
    assert run["mode"] == "agent"
    assert run["summary"] == "generated"
    assert run["row_count"] == 100
    assert run["decision"] is not None
    assert run["trust"] is not None


def test_agent_failure_does_not_break_full(monkeypatch, tmp_path):
    monkeypatch.setattr(monitoring_store, "STORE_PATH", str(tmp_path / "monitoring_runs.json"))

    def fail_llm(_prompt: str) -> str:
        raise RuntimeError("forced llm failure")

    monkeypatch.setattr(api, "_agent_llm", fail_llm)

    client = TestClient(api.app)

    agent_response = _post_file(client, "/agent", {"query": "generate 100 rows then analyze"})
    assert agent_response.status_code == 400

    full_response = _post_file(client, "/full", {"n": 20})
    assert full_response.status_code == 200
    assert full_response.json().get("mode") == "system"

