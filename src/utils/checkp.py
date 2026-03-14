"""
checkpoint.py — Generation CheckPoint
======================================

The CheckPoint is the final settlement layer of the synthetic-data
pipeline.  Only rows that have passed every filter in the
ValidationLayer are ever written here.

Pipeline position
-----------------

    parse.py
        ↓
    baseline.py
        ↓
    generator.py  ──(engine)──▶  ValidationLayer
                                       │
                                       │  clean rows (per round)
                                       ▼
                                  CheckPoint          ◀── background agent
                                       │                  polls status() /
                                       ▼                  calls export()
                                  final output

Responsibilities
----------------
1. Receive validated rows round-by-round via commit().
2. Persist them atomically to a structured JSON file on disk.
3. Record per-round metadata (timing, validation summary, round index).
4. Expose status() so the background agent can poll progress without
   loading the entire row store.
5. Expose export() so the agent can retrieve the final rows once the
   run is complete.
6. Expose reset() so the caller can start a fresh run on the same path
   without leaving stale data.

File format  (<cache_dir>/<fingerprint>_checkpoint.json)
---------------------------------------------------------
{
  "schema_version": "1.0",
  "dataset_fingerprint": "<str>",
  "generator_used": "<str>",
  "n_requested": <int>,
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "status": "in_progress" | "complete" | "failed",
  "final_warnings": [...],
  "commits": [
    {
      "commit_id":    <int>,        // 1-based, monotonically increasing
      "round":        <int>,        // generation round that produced this batch
      "n_rows":       <int>,        // rows appended in this commit
      "cumulative":   <int>,        // total accepted rows after this commit
      "committed_at": "<ISO-8601>",
      "validation": {
        "n_evaluated":            <int>,
        "n_accepted":             <int>,
        "n_rejected_quality":     <int>,
        "n_rejected_duplicates":  <int>,
        "n_repaired_constraints": <int>
      }
    },
    ...
  ],
  "rows": [...]    // flat list of all accepted row dicts, in commit order
}

Atomic writes
-------------
Every mutation writes to a temp file in the same directory then calls
os.replace() (POSIX-atomic rename).  A crash mid-write leaves the
previous checkpoint intact.

Agent interface
---------------
CheckPoint.status()  → CheckPointStatus   (lightweight, no row data)
CheckPoint.export()  → List[Dict]         (all accepted rows)

Both read the on-disk file directly so they work from any process.

Exports
-------
    CheckPointStatus  dataclass
    CommitMeta        dataclass
    CheckPoint        class
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_SCHEMA_VERSION = "1.0"

_STATUS_IN_PROGRESS = "in_progress"
_STATUS_COMPLETE    = "complete"
_STATUS_FAILED      = "failed"


# ==================================================================
# Public dataclasses
# ==================================================================

@dataclass
class CommitMeta:
    """
    Metadata recorded for every CheckPoint.commit() call.

    Attributes
    ----------
    commit_id    : 1-based sequence number within this run.
    round        : generation retry-loop round that produced the batch.
    n_rows       : rows appended in this commit.
    cumulative   : total accepted rows stored after this commit.
    committed_at : ISO-8601 UTC timestamp.
    validation   : summary dict from ValidationResult (counts only,
                   no row data).
    """
    commit_id    : int
    round        : int
    n_rows       : int
    cumulative   : int
    committed_at : str
    validation   : Dict[str, int] = field(default_factory=dict)


@dataclass
class CheckPointStatus:
    """
    Lightweight snapshot returned by CheckPoint.status().

    The background agent reads this without loading the row store.

    Attributes
    ----------
    status          : "in_progress" | "complete" | "failed"
    n_requested     : target row count for this run.
    n_collected     : rows accepted and persisted so far.
    progress_pct    : n_collected / n_requested * 100  (0–100).
    n_commits       : number of rounds committed so far.
    last_commit_at  : ISO-8601 timestamp of the most recent commit,
                      or None if no commits yet.
    generator_used  : engine name ("statistical" | "probabilistic" | "ctgan").
    dataset_fingerprint : fingerprint from the baseline artifact.
    final_warnings  : populated after seal(); empty while in_progress.
    is_complete     : True when status == "complete".
    is_failed       : True when status == "failed".
    """
    status              : str
    n_requested         : int
    n_collected         : int
    progress_pct        : float
    n_commits           : int
    last_commit_at      : Optional[str]
    generator_used      : str
    dataset_fingerprint : str
    final_warnings      : List[str]    = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        return self.status == _STATUS_COMPLETE

    @property
    def is_failed(self) -> bool:
        return self.status == _STATUS_FAILED


# ==================================================================
# CheckPoint
# ==================================================================

class CheckPoint:
    """
    Atomic, append-on-commit row store for one generation run.

    One CheckPoint instance corresponds to one generate() call.
    Multiple CheckPoint instances for different runs can coexist in
    the same cache_dir because each file is keyed by fingerprint +
    a disambiguating suffix.

    Parameters
    ----------
    path : str
        Absolute path to the checkpoint JSON file.
        Typically  <cache_dir>/<fingerprint>_checkpoint.json.
        The parent directory must already exist.
    n_requested : int
        Target number of rows for this run.
    dataset_fingerprint : str
        Fingerprint from the BaselineArtifact (used for tracing).
    generator_used : str
        Engine name recorded in the checkpoint header.

    Usage — inside generate()
    -------------------------
    >>> cp = CheckPoint(path, n_requested=n, ...)
    >>> cp.reset()                        # clear any stale data
    >>> for round_idx in range(max_rounds):
    ...     result = vl.run(batch, n_requested=n)
    ...     cp.commit(result.clean_df, round=round_idx, validation_result=result)
    ...     if cp.n_collected >= n:
    ...         break
    >>> cp.seal(status="complete", warnings=output_warnings)

    Usage — inside background agent
    --------------------------------
    >>> cp = CheckPoint.from_path(path)
    >>> status = cp.status()
    >>> if status.is_complete:
    ...     rows = cp.export()
    """

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(
        self,
        path:                str,
        n_requested:         int,
        dataset_fingerprint: str = "",
        generator_used:      str = "",
    ) -> None:
        self._path               = path
        self._n_requested        = n_requested
        self._dataset_fingerprint = dataset_fingerprint
        self._generator_used     = generator_used

    @classmethod
    def from_path(cls, path: str) -> "CheckPoint":
        """
        Construct a CheckPoint bound to an existing file.
        Used by the background agent when it only knows the file path.
        n_requested / fingerprint / generator_used are loaded from disk.
        """
        data = cls._read_raw(path)
        return cls(
            path                = path,
            n_requested         = int(data.get("n_requested", 0)),
            dataset_fingerprint = data.get("dataset_fingerprint", ""),
            generator_used      = data.get("generator_used", ""),
        )

    # ------------------------------------------------------------------
    # Public write API  (called by generate())
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """
        Overwrite the checkpoint file with an empty in-progress record.
        Must be called at the start of every new generate() run so
        stale rows from a previous run are not mixed in.
        """
        self._write({
            "schema_version":      _SCHEMA_VERSION,
            "dataset_fingerprint": self._dataset_fingerprint,
            "generator_used":      self._generator_used,
            "n_requested":         self._n_requested,
            "created_at":          _now_iso(),
            "updated_at":          _now_iso(),
            "status":              _STATUS_IN_PROGRESS,
            "final_warnings":      [],
            "commits":             [],
            "rows":                [],
        })

    def commit(
        self,
        clean_df:          Any,          # pd.DataFrame
        round:             int,
        validation_result: Any,          # ValidationResult (duck-typed)
    ) -> CommitMeta:
        """
        Append accepted rows and record metadata for one round.

        Parameters
        ----------
        clean_df          : pd.DataFrame of rows that passed every filter.
        round             : 0-based retry-loop round index.
        validation_result : ValidationResult from ValidationLayer.run().

        Returns
        -------
        CommitMeta for this commit.

        Raises
        ------
        RuntimeError if the checkpoint has already been sealed.
        """
        data = self._read_raw(self._path)

        if data.get("status") != _STATUS_IN_PROGRESS:
            raise RuntimeError(
                f"Cannot commit to a checkpoint with status "
                f"'{data.get('status')}'. Call reset() first."
            )

        # ---- Serialise new rows ----
        new_rows   = _df_to_json_records(clean_df)
        all_rows   = data.get("rows", [])
        all_rows.extend(new_rows)

        # ---- Build commit metadata ----
        commit_id  = len(data.get("commits", [])) + 1
        cumulative = len(all_rows)
        vr         = validation_result
        meta = CommitMeta(
            commit_id    = commit_id,
            round        = round,
            n_rows       = len(new_rows),
            cumulative   = cumulative,
            committed_at = _now_iso(),
            validation   = {
                "n_evaluated":            getattr(vr, "n_evaluated",            0),
                "n_accepted":             getattr(vr, "n_accepted",             0),
                "n_rejected_quality":     getattr(vr, "n_rejected_quality",     0),
                "n_rejected_duplicates":  getattr(vr, "n_rejected_duplicates",  0),
                "n_repaired_constraints": getattr(vr, "n_rejected_constraints", 0),
            },
        )

        data["commits"].append(asdict(meta))
        data["rows"]       = all_rows
        data["updated_at"] = _now_iso()

        self._write(data)
        return meta

    def seal(
        self,
        status:   str       = _STATUS_COMPLETE,
        warnings: List[str] = None,
    ) -> None:
        """
        Mark the run as finished.

        Parameters
        ----------
        status   : "complete" or "failed".
        warnings : final accumulated warnings from generate().
        """
        if status not in (_STATUS_COMPLETE, _STATUS_FAILED):
            raise ValueError(
                f"status must be 'complete' or 'failed', got '{status}'."
            )
        data = self._read_raw(self._path)
        data["status"]         = status
        data["updated_at"]     = _now_iso()
        data["final_warnings"] = list(warnings or [])
        self._write(data)

    # ------------------------------------------------------------------
    # Public read API  (called by the background agent)
    # ------------------------------------------------------------------

    def status(self) -> CheckPointStatus:
        """
        Return a lightweight status snapshot without loading row data.

        Safe to call from any process at any time — reads the on-disk
        file directly.
        """
        data       = self._read_raw(self._path)
        commits    = data.get("commits", [])
        n_collected = sum(c.get("n_rows", 0) for c in commits)
        n_req       = int(data.get("n_requested", 0))
        pct         = round(n_collected / max(n_req, 1) * 100.0, 2)
        last_commit = commits[-1].get("committed_at") if commits else None

        return CheckPointStatus(
            status              = data.get("status", _STATUS_IN_PROGRESS),
            n_requested         = n_req,
            n_collected         = n_collected,
            progress_pct        = pct,
            n_commits           = len(commits),
            last_commit_at      = last_commit,
            generator_used      = data.get("generator_used", ""),
            dataset_fingerprint = data.get("dataset_fingerprint", ""),
            final_warnings      = data.get("final_warnings", []),
        )

    def export(self) -> List[Dict[str, Any]]:
        """
        Return all accepted rows as a list of dicts.

        Can be called at any time — returns whatever has been committed
        so far, even if the run is still in_progress.  The agent should
        check status().is_complete before treating this as final output.
        """
        return self._read_raw(self._path).get("rows", [])

    def export_commits(self) -> List[CommitMeta]:
        """Return per-round commit metadata for diagnostics."""
        raw = self._read_raw(self._path).get("commits", [])
        return [CommitMeta(**c) for c in raw]

    @property
    def n_collected(self) -> int:
        """Current row count without loading rows (reads commits only)."""
        data    = self._read_raw(self._path)
        commits = data.get("commits", [])
        return sum(c.get("n_rows", 0) for c in commits)

    @property
    def path(self) -> str:
        return self._path

    # ------------------------------------------------------------------
    # Atomic I/O
    # ------------------------------------------------------------------

    def _write(self, data: Dict[str, Any]) -> None:
        """
        Write data to the checkpoint file atomically.

        Writes to a temporary file in the same directory then calls
        os.replace() so the checkpoint is never left in a partial state.
        """
        dir_path = os.path.dirname(self._path) or "."
        fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, default=_json_default)
            os.replace(tmp, self._path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _read_raw(path: str) -> Dict[str, Any]:
        """
        Read and return the raw checkpoint dict.

        Returns an empty skeleton if the file does not exist yet — this
        allows status() and export() to be called before reset() is
        called, e.g. right after the CheckPoint object is constructed.
        """
        if not os.path.exists(path):
            return {
                "schema_version":      _SCHEMA_VERSION,
                "dataset_fingerprint": "",
                "generator_used":      "",
                "n_requested":         0,
                "created_at":          "",
                "updated_at":          "",
                "status":              _STATUS_IN_PROGRESS,
                "final_warnings":      [],
                "commits":             [],
                "rows":                [],
            }
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    # ------------------------------------------------------------------
    # Convenience: default path helper
    # ------------------------------------------------------------------

    @staticmethod
    def default_path(cache_dir: str, fingerprint: str) -> str:
        """
        Return the canonical checkpoint file path for a given run.

        >>> path = CheckPoint.default_path("/tmp/cache", "abc123")
        >>> # /tmp/cache/abc123_checkpoint.json
        """
        safe = fingerprint[:32] if fingerprint else "unknown"
        return os.path.join(cache_dir, f"{safe}_checkpoint.json")


# ==================================================================
# Private helpers
# ==================================================================

def _now_iso() -> str:
    """Return current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_default(obj: Any) -> Any:
    """JSON serialiser for types not handled by the stdlib encoder."""
    if hasattr(obj, "item"):           # numpy scalar
        return obj.item()
    if hasattr(obj, "isoformat"):      # datetime
        return obj.isoformat()
    if obj is None:
        return None
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _df_to_json_records(df: Any) -> List[Dict[str, Any]]:
    """Convert a DataFrame to a list of JSON-safe dicts (NaN → None)."""
    import math as _math
    records = []
    for row in df.to_dict(orient="records"):
        clean = {}
        for k, v in row.items():
            if isinstance(v, float) and (_math.isnan(v) or _math.isinf(v)):
                clean[k] = None
            elif hasattr(v, "item"):
                clean[k] = v.item()
            else:
                try:
                    import pandas as _pd
                    if v is _pd.NA or v is _pd.NaT:
                        clean[k] = None
                        continue
                except Exception:
                    pass
                clean[k] = v
        records.append(clean)
    return records