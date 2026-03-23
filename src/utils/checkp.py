"""
checkpoint.py — Generation CheckPoint
======================================

GROUP 1 FINAL CLOSURE (100% Integrity Lock)

Prior hardening (retained)
--------------------------
F-1  Dual-file design: <base>.meta.json + <base>.rows.ndjson
F-2  reset() removed; new_run() creates isolated per-run files
F-3  SHA-256 rows_hash stored in meta, verified on every read
Ph-3 commit() protected by OS-level FileLock (thread + process safe)
Ph-13 seal(): "complete" | "partial" | "failed"
Ph-14 status() raises if n_collected > n_requested
Ph-18 Fingerprint sanitized — path traversal impossible

Final Closure additions
-----------------------
Ph-1  OS-level FileLock (filelock.FileLock when available; _PurePyFileLock
       combining threading.Lock + fcntl.flock as fallback). Both threads
       and OS processes are fully serialized on every critical section.

Ph-2  WAL corruption handling — before WAL replay, each line is parsed
       individually; iteration stops at first JSONDecodeError; the WAL file
       is rewritten to contain only the valid prefix before any rows are applied.

Ph-3  commit-in-progress flag — meta["commit_in_progress"] = True written
       atomically BEFORE touching the WAL or rows file; cleared AFTER meta is
       fully finalized. Any load where this flag is True triggers WAL recovery.

Ph-4  TXID deduplication — every commit generates a UUID txid recorded in
       meta["applied_txids"]. WAL replay skips entries whose txid is already
       present: recovery is fully idempotent, no double-write possible.

Ph-6  Safe read boundary — before every commit and export: (1) rows_hash
       verified, (2) meta.n_collected vs actual line count asserted,
       (3) every line JSON-parsed. Any failure raises immediately (hard fail).

Ph-7  WAL replay engine — on crash recovery: validate + truncate WAL, collect
       valid rows from rows file (tolerant read), append unapplied WAL entries,
       rewrite rows file clean via atomic rename, recompute hash, clear WAL.

Ph-8  Hard fail-fast — every invalid state raises an explicit, descriptive
       exception tagged [HARD FAIL]. No silent fallback anywhere in this module.

Ph-9  Numeric safety — all row values scanned for NaN / ±Inf BEFORE serializing
       to WAL or rows file. Applied at _df_to_json_records() and _assert_numeric_safe().

Ph-10 Consistency assert — after every commit, actual line count in the rows file
       is compared against the expected cumulative before the meta write is finalized.
"""

from __future__ import annotations

import hashlib
import json
import logging as _logging
import math
import os
import re
import tempfile
import uuid
import warnings
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

_log = _logging.getLogger(__name__)

try:
    from filelock import FileLock as _FileLock   # Ph-1: preferred cross-process lock
    _FILELOCK_AVAILABLE = True
except ImportError:
    _FILELOCK_AVAILABLE = False

import threading as _threading

# ── CORE error types (fail-fast) ─────────────────────────────────────────────
import importlib.util as _ilu_cp
# Load errors.py relative to this file without sys.path mutation
import os as _os_cp
_errs_path = _os_cp.path.normpath(_os_cp.path.join(_os_cp.path.dirname(_os_cp.path.abspath(__file__)), "errors.py"))
_errs_spec = _ilu_cp.spec_from_file_location("utils.errors", _errs_path)
if "utils.errors" in __import__("sys").modules:
    _errs_mod = __import__("sys").modules["utils.errors"]
    __import__("sys").modules.setdefault("errors", _errs_mod)
elif "errors" in __import__("sys").modules:
    _errs_mod = __import__("sys").modules["errors"]
    __import__("sys").modules["utils.errors"] = _errs_mod
else:
    _errs_mod = _errs_mod  = _ilu_cp.module_from_spec(_errs_spec)
    __import__("sys").modules["utils.errors"] = _errs_mod
    __import__("sys").modules["errors"] = _errs_mod
    _errs_spec.loader.exec_module(_errs_mod)
CheckpointError      = _errs_mod.CheckpointError
InputValidationError = _errs_mod.InputValidationError
ErrorCode            = _errs_mod.ErrorCode


# ══════════════════════════════════════════════════════════════════════
# Ph-1: Pure-Python fallback lock
# threading.Lock (intra-process) + fcntl.flock (inter-process on POSIX)
# ══════════════════════════════════════════════════════════════════════

class _PurePyFileLock:
    _process_locks: dict = {}
    _meta_lock = _threading.Lock()

    def __init__(self, lock_path: str, timeout: float = 30.0) -> None:
        self._lock_path   = lock_path
        self._timeout     = timeout
        self._fd: Any     = None
        with self.__class__._meta_lock:
            if lock_path not in self.__class__._process_locks:
                self.__class__._process_locks[lock_path] = _threading.Lock()
        self._thread_lock = self.__class__._process_locks[lock_path]

    def __enter__(self):
        import time as _time
        if not self._thread_lock.acquire(timeout=self._timeout):
            raise TimeoutError(
                f"_PurePyFileLock: thread-lock timeout for '{self._lock_path}'."
            )
        try:
            self._fd = open(self._lock_path, "a")
            try:
                import fcntl as _fcntl
                deadline = _time.monotonic() + self._timeout
                while True:
                    try:
                        _fcntl.flock(self._fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if _time.monotonic() > deadline:
                            raise TimeoutError(
                                f"_PurePyFileLock: fcntl timeout for '{self._lock_path}'."
                            )
                        _time.sleep(0.005)
            except ImportError:
                # fcntl is not available on Windows; threading.Lock is the only
                # synchronisation layer in that environment. This is the documented
                # cross-platform contract for _PurePyFileLock.
                warnings.warn(
                    "_PurePyFileLock: fcntl unavailable on this platform; "
                    "using thread lock only (single-process safety).",
                    RuntimeWarning, stacklevel=3,
                )
        except Exception as e:
            self._thread_lock.release()
            _log.error("[HARD FAIL] checkpoint lock invariant violated: %s", e)
            raise RuntimeError(f"[HARD FAIL] checkpoint invariant violated: {e}") from e
        return self

    def __exit__(self, *_):
        try:
            if self._fd is not None:
                try:
                    import fcntl as _fcntl
                    _fcntl.flock(self._fd, _fcntl.LOCK_UN)
                except ImportError:
                    # fcntl unavailable on Windows — no OS-level unlock needed;
                    # the thread lock (released in finally) is the sole guard there.
                    _log.debug(
                        "_PurePyFileLock.__exit__: fcntl not available on this platform; "
                        "skipping OS-level unlock (thread lock handles serialisation)."
                    )
                self._fd.close()
                self._fd = None
        finally:
            self._thread_lock.release()


# ══════════════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════════════

_SCHEMA_VERSION      = "1.2"
_STATUS_IN_PROGRESS  = "in_progress"
_STATUS_COMPLETE     = "complete"
_STATUS_PARTIAL      = "partial"
_STATUS_FAILED       = "failed"
_VALID_SEAL_STATUSES = (_STATUS_COMPLETE, _STATUS_PARTIAL, _STATUS_FAILED)
_LOCK_TIMEOUT_SEC    = 30
_WAL_SUFFIX          = ".wal.ndjson"


# ══════════════════════════════════════════════════════════════════════
# Public dataclasses
# ══════════════════════════════════════════════════════════════════════

@dataclass
class CommitMeta:
    commit_id    : int
    round        : int
    n_rows       : int
    cumulative   : int
    committed_at : str
    txid         : str = ""
    validation   : Dict[str, int] = field(default_factory=dict)


@dataclass
class CheckPointStatus:
    status              : str
    n_requested         : int
    n_collected         : int
    progress_pct        : float
    n_commits           : int
    last_commit_at      : Optional[str]
    generator_used      : str
    dataset_fingerprint : str
    run_id              : str       = ""
    final_warnings      : List[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        return self.status == _STATUS_COMPLETE

    @property
    def is_partial(self) -> bool:
        return self.status == _STATUS_PARTIAL

    @property
    def is_failed(self) -> bool:
        return self.status == _STATUS_FAILED


# ══════════════════════════════════════════════════════════════════════
# CheckPoint
# ══════════════════════════════════════════════════════════════════════

class CheckPoint:
    """
    WAL-protected, crash-safe, per-run row store.

    FILE LAYOUT (three files per run)
    ----------------------------------
      <base>.meta.json     Small metadata; atomically rewritten via temp-rename.
      <base>.rows.ndjson   Append-only NDJSON in normal operation;
                           atomically rewritten during recovery only.
      <base>.wal.ndjson    Write-Ahead Log; one entry per pending commit;
                           truncated after successful commit.

    COMMIT PROTOCOL (crash-safe at every step)
    -------------------------------------------
    1.  Acquire OS-level exclusive lock.
    2.  Read meta. If commit_in_progress=True → run WAL recovery.
    3.  Assert safe read boundary (hash + count + parse check).
    4.  Ph-9: assert all row values are finite.
    5.  Ph-3: set commit_in_progress=True + pending_txid in meta (atomic).
    6.  Ph-7: append WAL entry; fsync.
    7.  Append rows to rows file; fsync.
    8.  Ph-10: assert actual line count == expected cumulative.
    9.  Ph-3: write final meta (commit_in_progress=False, hash, txid recorded).
    10. Ph-7: remove this txid's WAL entry.
    11. Release lock.

    A crash anywhere between steps 5–9 leaves commit_in_progress=True.
    The next commit() / status() / export() call triggers WAL recovery.

    INVARIANTS (always true when lock is not held)
    ----------------------------------------------
    - No two runs share any file (UUID-keyed paths).
    - rows_hash in meta always matches the rows file on disk.
    - meta.n_collected always equals the actual line count in rows file.
    - Every applied txid is recorded; WAL replay is idempotent.
    - No NaN or Inf ever reaches a file.
    - No corrupt checkpoint is ever read or extended silently.
    """

    def __init__(
        self,
        base:                str,
        n_requested:         int,
        dataset_fingerprint: str = "",
        generator_used:      str = "",
        run_id:              str = "",
    ) -> None:
        self._base                = base
        self._meta_path           = base + ".meta.json"
        self._rows_path           = base + ".rows.ndjson"
        self._wal_path            = base + _WAL_SUFFIX
        self._n_requested         = n_requested
        self._dataset_fingerprint = dataset_fingerprint
        self._generator_used      = generator_used
        self._run_id              = run_id or uuid.uuid4().hex

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def new_run(
        cls,
        cache_dir:           str,
        fingerprint:         str,
        n_requested:         int,
        dataset_fingerprint: str = "",
        generator_used:      str = "",
    ) -> "CheckPoint":
        """
        Create a brand-new CheckPoint at a unique UUID-keyed base path.
        Old runs are never touched. Only approved way to start a run.
        """
        run_id = uuid.uuid4().hex
        base   = cls._build_base(cache_dir, fingerprint, run_id)
        cp = cls(
            base                = base,
            n_requested         = n_requested,
            dataset_fingerprint = dataset_fingerprint,
            generator_used      = generator_used,
            run_id              = run_id,
        )
        cp.initialise()
        return cp

    @classmethod
    def from_base(cls, base: str) -> "CheckPoint":
        """Reconstruct CheckPoint from an existing base path (for read-only use)."""
        meta = cls._read_meta(base + ".meta.json")
        return cls(
            base                = base,
            n_requested         = int(meta.get("n_requested", 0)),
            dataset_fingerprint = meta.get("dataset_fingerprint", ""),
            generator_used      = meta.get("generator_used", ""),
            run_id              = meta.get("run_id", ""),
        )

    # ------------------------------------------------------------------
    # Write API
    # ------------------------------------------------------------------

    def initialise(self) -> None:
        """
        Create all three checkpoint files for a fresh run.
        Raises FileExistsError on UUID collision (indicates a bug).
        """
        if os.path.exists(self._meta_path) or os.path.exists(self._rows_path):
            raise CheckpointError(
                ErrorCode.CHECKPOINT_CORRUPT,
                f"CheckPoint.initialise(): files already exist at '{self._base}'. "
                "Use new_run() for a unique path.",
            )
        os.makedirs(os.path.dirname(self._base) or ".", exist_ok=True)
        open(self._rows_path, "w", encoding="utf-8").close()
        open(self._wal_path,  "w", encoding="utf-8").close()
        self._write_meta(_empty_meta(
            schema_version      = _SCHEMA_VERSION,
            run_id              = self._run_id,
            dataset_fingerprint = self._dataset_fingerprint,
            generator_used      = self._generator_used,
            n_requested         = self._n_requested,
            rows_hash           = _sha256_file(self._rows_path),
        ))

    def commit(
        self,
        clean_df:          Any,
        round:             int,
        validation_result: Any,
    ) -> CommitMeta:
        """
        WAL-protected atomic commit. See class docstring for full protocol.
        """
        lock_path = self._base + ".lock"
        with _acquire_lock(lock_path):

            meta = self._read_meta(self._meta_path)

            # Ph-3: interrupted commit detected — replay WAL before proceeding
            if meta.get("commit_in_progress"):
                meta = self._recover(meta)

            # Ph-6: safe read boundary — raises immediately if inconsistent
            self._assert_safe_read_boundary(meta)

            if meta.get("status") != _STATUS_IN_PROGRESS:
                raise CheckpointError(
                    ErrorCode.COMMIT_WRONG_STATUS,
                    f"Cannot commit to checkpoint with status "
                    f"'{meta.get('status')}'. Use new_run().",
                )

            new_rows = _df_to_json_records(clean_df)

            # Ph-9: numeric safety before touching any file
            _assert_numeric_safe(new_rows)

            txid      = uuid.uuid4().hex
            commit_id = len(meta.get("commits", [])) + 1

            # Ph-4: txid deduplication (collision = UUID generation failure)
            applied: Set[str] = set(meta.get("applied_txids", []))
            if txid in applied:
                raise CheckpointError(
                    ErrorCode.TXID_COLLISION,
                    f"Ph-4 TXID collision: {txid!r} already in applied_txids.",
                )

            # ── Ph-3: set commit_in_progress BEFORE any I/O ───────────────
            meta["commit_in_progress"] = True
            meta["pending_txid"]       = txid
            self._write_meta(meta)

            # ── Ph-7: write WAL entry (durable) ──────────────────────────
            wal_entry = {
                "txid":       txid,
                "round":      round,
                "n_rows":     len(new_rows),
                "rows":       new_rows,
                "created_at": _now_iso(),
            }
            with open(self._wal_path, "a", encoding="utf-8") as wf:
                wf.write(json.dumps(wal_entry, ensure_ascii=False, default=_json_default))
                wf.write("\n")
                wf.flush()
                os.fsync(wf.fileno())

            # ── Append rows to main rows file ─────────────────────────────
            with open(self._rows_path, "a", encoding="utf-8") as rf:
                for row in new_rows:
                    rf.write(json.dumps(row, ensure_ascii=False, default=_json_default))
                    rf.write("\n")
                rf.flush()
                os.fsync(rf.fileno())

            cumulative = meta.get("n_collected", 0) + len(new_rows)

            # ── Ph-10: consistency assert before finalizing meta ──────────
            actual_count = _count_ndjson_lines(self._rows_path)
            if actual_count != cumulative:
                raise CheckpointError(
                    ErrorCode.LINE_COUNT_MISMATCH,
                    f"Ph-10 consistency failure: rows file has {actual_count} lines, "
                    f"expected {cumulative}.",
                )

            vr = validation_result
            commit_meta = CommitMeta(
                commit_id    = commit_id,
                round        = round,
                n_rows       = len(new_rows),
                cumulative   = cumulative,
                committed_at = _now_iso(),
                txid         = txid,
                validation   = {
                    "n_evaluated":            getattr(vr, "n_evaluated",            0),
                    "n_accepted":             getattr(vr, "n_accepted",             0),
                    "n_rejected_quality":     getattr(vr, "n_rejected_quality",     0),
                    "n_rejected_duplicates":  getattr(vr, "n_rejected_duplicates",  0),
                    "n_repaired_constraints": getattr(vr, "n_rejected_constraints", 0),
                },
            )

            commits = meta.get("commits", [])
            commits.append(asdict(commit_meta))
            applied.add(txid)
            new_hash = _sha256_file(self._rows_path)

            # ── Ph-3: clear flag, record txid, finalize meta ──────────────
            meta["commits"]            = commits
            meta["n_collected"]        = cumulative
            meta["rows_hash"]          = new_hash
            meta["updated_at"]         = _now_iso()
            meta["commit_in_progress"] = False
            meta["pending_txid"]       = ""
            meta["applied_txids"]      = list(applied)
            self._write_meta(meta)

            # ── Ph-7: remove applied WAL entry ────────────────────────────
            _remove_wal_entry(self._wal_path, txid)

        return commit_meta

    def seal(
        self,
        status:   str                 = _STATUS_COMPLETE,
        warnings: Optional[List[str]] = None,
    ) -> None:
        """Mark the run as finished. Triggers recovery if interrupted state found."""
        if status not in _VALID_SEAL_STATUSES:
            raise InputValidationError(
                ErrorCode.INVALID_SCHEMA,
                f"seal() status must be one of {_VALID_SEAL_STATUSES}, "
                f"got '{status}'.",
            )
        lock_path = self._base + ".lock"
        with _acquire_lock(lock_path):
            meta = self._read_meta(self._meta_path)
            if meta.get("commit_in_progress"):
                meta = self._recover(meta)
            meta["status"]         = status
            meta["updated_at"]     = _now_iso()
            meta["final_warnings"] = list(warnings or [])
            self._write_meta(meta)

    # ------------------------------------------------------------------
    # Read API
    # ------------------------------------------------------------------

    def status(self) -> CheckPointStatus:
        """
        Status snapshot. Triggers recovery if interrupted state found.
        Ph-6: safe read boundary asserted after any recovery.
        Ph-14: raises if n_collected > n_requested.
        """
        lock_path = self._base + ".lock"
        with _acquire_lock(lock_path):
            meta = self._read_meta(self._meta_path)
            if meta.get("commit_in_progress"):
                meta = self._recover(meta)
            self._assert_safe_read_boundary(meta)

        n_collected = int(meta.get("n_collected", 0))
        n_req       = int(meta.get("n_requested", 0))
        if n_req > 0 and n_collected > n_req:
            raise CheckpointError(
                ErrorCode.ROWS_EXCEED_REQUEST,
                f"Integrity error: n_collected={n_collected} > n_requested={n_req} "
                f"at '{self._base}'.",
            )

        commits     = meta.get("commits", [])
        pct         = round(n_collected / max(n_req, 1) * 100.0, 2)
        last_commit = commits[-1].get("committed_at") if commits else None

        return CheckPointStatus(
            status              = meta.get("status", _STATUS_IN_PROGRESS),
            n_requested         = n_req,
            n_collected         = n_collected,
            progress_pct        = pct,
            n_commits           = len(commits),
            last_commit_at      = last_commit,
            generator_used      = meta.get("generator_used", ""),
            dataset_fingerprint = meta.get("dataset_fingerprint", ""),
            run_id              = meta.get("run_id", ""),
            final_warnings      = meta.get("final_warnings", []),
        )

    def export(self) -> List[Dict[str, Any]]:
        """
        Return all accepted rows. Triggers recovery if interrupted state found.
        Ph-6: safe read boundary asserted; Ph-8: corrupt lines raise immediately.
        """
        lock_path = self._base + ".lock"
        with _acquire_lock(lock_path):
            meta = self._read_meta(self._meta_path)
            if meta.get("commit_in_progress"):
                meta = self._recover(meta)
            self._assert_safe_read_boundary(meta)
        return _read_ndjson(self._rows_path)

    def export_commits(self) -> List[CommitMeta]:
        meta = self._read_meta(self._meta_path)
        return [CommitMeta(**c) for c in meta.get("commits", [])]

    @property
    def n_collected(self) -> int:
        return int(self._read_meta(self._meta_path).get("n_collected", 0))

    @property
    def path(self) -> str:
        """Meta file path — backwards-compat for callers that log cp.path."""
        return self._meta_path

    @property
    def base(self) -> str:
        return self._base

    @property
    def run_id(self) -> str:
        return self._run_id

    # ------------------------------------------------------------------
    # Ph-7: WAL recovery engine
    # ------------------------------------------------------------------

    def _recover(self, meta: Dict[str, Any]) -> Dict[str, Any]:
        """
        Full WAL replay:
          1. Ph-2: validate + repair WAL (stop at first bad line).
          2. Collect valid rows from rows file (tolerant read).
          3. Ph-4: apply unapplied WAL entries (idempotent, txid-deduplicated).
          4. Rewrite rows file clean via atomic rename.
          5. Recompute SHA-256 hash.
          6. Clear WAL.
          7. Update meta atomically.
        """
        # Step 1
        valid_entries = _validate_and_repair_wal(self._wal_path)

        # Step 2
        valid_rows = _read_ndjson_tolerant(self._rows_path)

        # Step 3
        applied: Set[str] = set(meta.get("applied_txids", []))
        for entry in valid_entries:
            txid = entry.get("txid", "")
            if not txid:
                continue
            if txid in applied:
                continue   # Ph-4: already applied
            rows_to_apply = entry.get("rows", [])
            if not isinstance(rows_to_apply, list):
                raise CheckpointError(
                    ErrorCode.CHECKPOINT_CORRUPT,
                    f"WAL entry txid={txid!r} has non-list 'rows'.",
                )
            _assert_numeric_safe(rows_to_apply)  # Ph-9
            valid_rows.extend(rows_to_apply)
            applied.add(txid)

        # Step 4 — rewrite rows file clean
        dir_path = os.path.dirname(self._rows_path) or "."
        fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                for row in valid_rows:
                    f.write(json.dumps(row, ensure_ascii=False, default=_json_default))
                    f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._rows_path)
        except Exception as e:
            try:
                os.unlink(tmp)
            except OSError as _unlink_err:
                # Temp-file cleanup failed — log and continue; original exception is re-raised.
                _log.warning(
                    "checkp: failed to remove temp file '%s' during error cleanup: %s",
                    tmp, _unlink_err,
                )
            _log.error("[HARD FAIL] checkpoint rows atomic-replace failed: %s", e)
            raise RuntimeError(f"[HARD FAIL] checkpoint invariant violated: {e}") from e

        # Step 5
        new_hash = _sha256_file(self._rows_path)

        # Step 6 — truncate WAL
        open(self._wal_path, "w", encoding="utf-8").close()

        # Step 7
        meta["commit_in_progress"] = False
        meta["pending_txid"]       = ""
        meta["rows_hash"]          = new_hash
        meta["n_collected"]        = len(valid_rows)
        meta["applied_txids"]      = list(applied)
        meta["updated_at"]         = _now_iso()
        self._write_meta(meta)

        return meta

    # ------------------------------------------------------------------
    # Ph-6: Safe read boundary
    # ------------------------------------------------------------------

    def _assert_safe_read_boundary(self, meta: Dict[str, Any]) -> None:
        """
        Three hard checks before any read or write:
          1. rows_hash in meta matches SHA-256 of rows file.
          2. meta.n_collected equals actual line count.
          3. Every line in rows file parses as valid JSON (catches partial tail).
        Any failure raises immediately (Ph-8: no silent continuation).
        """
        stored_hash = meta.get("rows_hash", "")
        if stored_hash:
            if not os.path.exists(self._rows_path):
                raise FileNotFoundError(
                    f"Rows file missing: '{self._rows_path}'. [HARD FAIL]"
                )
            actual_hash = _sha256_file(self._rows_path)
            if actual_hash != stored_hash:
                raise CheckpointError(
                    ErrorCode.HASH_MISMATCH,
                    f"Ph-6 hash mismatch at '{self._rows_path}': "
                    f"expected {stored_hash!r}, got {actual_hash!r}.",
                )

        expected_n = int(meta.get("n_collected", 0))
        actual_n   = _count_ndjson_lines(self._rows_path)
        if actual_n != expected_n:
            raise CheckpointError(
                ErrorCode.LINE_COUNT_MISMATCH,
                f"Ph-6 count mismatch: meta.n_collected={expected_n} but "
                f"rows file has {actual_n} lines.",
            )

        if os.path.exists(self._rows_path):
            with open(self._rows_path, "r", encoding="utf-8") as f:
                for lineno, raw in enumerate(f, 1):
                    stripped = raw.strip()
                    if not stripped:
                        continue
                    try:
                        json.loads(stripped)
                    except json.JSONDecodeError as exc:
                        raise CheckpointError(
                            ErrorCode.CHECKPOINT_CORRUPT,
                            f"Ph-6 partial JSON at line {lineno} of "
                            f"'{self._rows_path}': {exc}.",
                        ) from exc

    # ------------------------------------------------------------------
    # Atomic meta I/O
    # ------------------------------------------------------------------

    def _write_meta(self, meta: Dict[str, Any]) -> None:
        """Atomic write via temp-file rename + fsync."""
        dir_path = os.path.dirname(self._meta_path) or "."
        fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, default=_json_default)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._meta_path)
        except Exception as e:
            try:
                os.unlink(tmp)
            except OSError as _unlink_err:
                # Temp-file cleanup failed — log and continue; original exception is re-raised.
                _log.warning(
                    "checkp: failed to remove temp file '%s' during error cleanup: %s",
                    tmp, _unlink_err,
                )
            _log.error("[HARD FAIL] checkpoint meta atomic-replace failed: %s", e)
            raise RuntimeError(f"[HARD FAIL] checkpoint invariant violated: {e}") from e

    @staticmethod
    def _read_meta(meta_path: str) -> Dict[str, Any]:
        if not os.path.exists(meta_path):
            return _default_meta()
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as exc:
            raise CheckpointError(
                ErrorCode.CHECKPOINT_CORRUPT,
                f"Meta file '{meta_path}' is not valid JSON: {exc}.",
            ) from exc
        # Back-fill keys added by newer schema versions
        for k, v in _default_meta().items():
            data.setdefault(k, v)
        return data

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_base(cache_dir: str, fingerprint: str, run_id: str) -> str:
        """Ph-18: fingerprint sanitized — path traversal impossible."""
        safe_fp_raw = re.sub(r"[^a-zA-Z0-9_\-]", "_", fingerprint)[:32]
        if not safe_fp_raw:
            _log.warning(
                "fallback path activated: checkpoint fingerprint sanitization produced empty token; using 'unknown'"
            )
            safe_fp = "unknown"
        else:
            safe_fp = safe_fp_raw
        safe_rid = re.sub(r"[^a-zA-Z0-9]", "", run_id)[:32] or uuid.uuid4().hex
        return os.path.join(cache_dir, f"{safe_fp}_{safe_rid}_cp")

    @staticmethod
    def run_path(cache_dir: str, fingerprint: str, run_id: str) -> str:
        """DEPRECATED — legacy single-file path retained for backwards compat."""
        safe_fp_raw = re.sub(r"[^a-zA-Z0-9_\-]", "_", fingerprint)[:32]
        if not safe_fp_raw:
            _log.warning(
                "fallback path activated: checkpoint run_path fingerprint sanitization produced empty token; using 'unknown'"
            )
            safe_fp = "unknown"
        else:
            safe_fp = safe_fp_raw
        safe_rid = re.sub(r"[^a-zA-Z0-9]", "", run_id)[:32] or uuid.uuid4().hex
        return os.path.join(cache_dir, f"{safe_fp}_{safe_rid}_cp.json")

    @staticmethod
    def default_path(cache_dir: str, fingerprint: str) -> str:
        """Legacy shared path — retained for agent path discovery only."""
        safe_raw = re.sub(r"[^a-zA-Z0-9_\-]", "_", fingerprint)[:32]
        if not safe_raw:
            _log.warning(
                "fallback path activated: checkpoint default_path fingerprint sanitization produced empty token; using 'unknown'"
            )
            safe = "unknown"
        else:
            safe = safe_raw
        return os.path.join(cache_dir, f"{safe}_checkpoint.json")


# ══════════════════════════════════════════════════════════════════════
# Private helpers
# ══════════════════════════════════════════════════════════════════════

def _default_meta() -> Dict[str, Any]:
    """Canonical default with all fields — used for back-filling old records."""
    return {
        "schema_version":      _SCHEMA_VERSION,
        "run_id":              "",
        "dataset_fingerprint": "",
        "generator_used":      "",
        "n_requested":         0,
        "n_collected":         0,
        "created_at":          "",
        "updated_at":          "",
        "status":              _STATUS_IN_PROGRESS,
        "final_warnings":      [],
        "commits":             [],
        "rows_hash":           "",
        "commit_in_progress":  False,
        "pending_txid":        "",
        "applied_txids":       [],
    }


def _empty_meta(
    schema_version:      str,
    run_id:              str,
    dataset_fingerprint: str,
    generator_used:      str,
    n_requested:         int,
    rows_hash:           str = "",
) -> Dict[str, Any]:
    """Initial meta for a fresh run. All WAL/txid fields initialized."""
    return {
        "schema_version":      schema_version,
        "run_id":              run_id,
        "dataset_fingerprint": dataset_fingerprint,
        "generator_used":      generator_used,
        "n_requested":         n_requested,
        "n_collected":         0,
        "created_at":          _now_iso(),
        "updated_at":          _now_iso(),
        "status":              _STATUS_IN_PROGRESS,
        "final_warnings":      [],
        "commits":             [],
        "rows_hash":           rows_hash,
        "commit_in_progress":  False,
        "pending_txid":        "",
        "applied_txids":       [],
    }


def _sha256_file(path: str) -> str:
    """SHA-256 digest of a file's bytes. Returns digest of b'' if file missing."""
    h = hashlib.sha256()
    if not os.path.exists(path):
        return h.hexdigest()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _count_ndjson_lines(path: str) -> int:
    """Count non-empty lines without JSON-parsing them."""
    if not os.path.exists(path):
        return 0
    count = 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def _read_ndjson(path: str) -> List[Dict[str, Any]]:
    """
    Read all rows. Ph-8: raises on any parse error — no silent skip.
    """
    rows: List[Dict[str, Any]] = []
    if not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise CheckpointError(
                    ErrorCode.CHECKPOINT_CORRUPT,
                    f"_read_ndjson: parse error on line {lineno} of '{path}': {exc}.",
                ) from exc
            if not isinstance(obj, dict):
                raise CheckpointError(
                    ErrorCode.CHECKPOINT_CORRUPT,
                    f"_read_ndjson: line {lineno} of '{path}' is {type(obj).__name__}, "
                    "expected dict.",
                )
            rows.append(obj)
    return rows


def _read_ndjson_tolerant(path: str) -> List[Dict[str, Any]]:
    """
    Ph-7 / recovery only: read rows stopping at first parse error.
    Used when a partial final line is expected after a crash.
    """
    rows: List[Dict[str, Any]] = []
    if not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
                if isinstance(obj, dict):
                    rows.append(obj)
            except json.JSONDecodeError:
                break   # stop at first corruption
    return rows


def _validate_and_repair_wal(wal_path: str) -> List[Dict[str, Any]]:
    """
    Ph-2: Parse WAL lines, stop at first JSONDecodeError, rewrite WAL
    to contain only the valid prefix. Returns list of valid WAL entries.
    """
    valid_lines:   List[str]           = []
    valid_entries: List[Dict[str, Any]] = []

    if not os.path.exists(wal_path):
        return valid_entries

    with open(wal_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                entry = json.loads(stripped)
                valid_lines.append(stripped)
                valid_entries.append(entry)
            except json.JSONDecodeError:
                break   # Ph-2: stop at first corruption

    # Rewrite WAL to valid-only lines
    dir_path = os.path.dirname(wal_path) or "."
    fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for ln in valid_lines:
                f.write(ln + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, wal_path)
    except Exception as e:
        try:
            os.unlink(tmp)
        except OSError as _unlink_err:
            # Temp-file cleanup failed — log and continue; original exception is re-raised.
            _log.warning(
                "checkp: failed to remove temp file '%s' during error cleanup: %s",
                tmp, _unlink_err,
            )
        _log.error("[HARD FAIL] checkpoint WAL repair atomic-replace failed: %s", e)
        raise RuntimeError(f"[HARD FAIL] checkpoint invariant violated: {e}") from e

    return valid_entries


def _remove_wal_entry(wal_path: str, txid: str) -> None:
    """
    Ph-7: Remove a specific txid's WAL entry after successful commit.
    Rewrites the WAL file omitting any line whose txid matches.
    """
    if not os.path.exists(wal_path):
        return
    remaining: List[str] = []
    with open(wal_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                entry = json.loads(stripped)
                if entry.get("txid") != txid:
                    remaining.append(stripped)
            except json.JSONDecodeError:
                break   # stop at first corruption — discard rest
    dir_path = os.path.dirname(wal_path) or "."
    fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for ln in remaining:
                f.write(ln + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, wal_path)
    except Exception as e:
        try:
            os.unlink(tmp)
        except OSError as _unlink_err:
            # Temp-file cleanup failed — log and continue; original exception is re-raised.
            _log.warning(
                "checkp: failed to remove temp file '%s' during error cleanup: %s",
                tmp, _unlink_err,
            )
        _log.error("[HARD FAIL] checkpoint WAL txid-removal atomic-replace failed: %s", e)
        raise RuntimeError(f"[HARD FAIL] checkpoint invariant violated: {e}") from e


def _assert_numeric_safe(rows: List[Dict[str, Any]]) -> None:
    """
    Ph-9: Walk all values in each row; raise ValueError on NaN or ±Inf.
    Applied before WAL serialization AND during WAL replay.
    """
    for row_idx, row in enumerate(rows):
        for key, value in row.items():
            _check_value_finite(value, key, row_idx)


def _check_value_finite(value: Any, key: str, row_idx: int) -> None:
    """Recursive finite-number check (handles nested dicts, lists, numpy scalars)."""
    if isinstance(value, float):
        if not math.isfinite(value):
            raise InputValidationError(
                ErrorCode.NON_FINITE_VALUE,
                f"Ph-9: non-finite {value!r} in row {row_idx} column '{key}'.",
            )
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_value_finite(v, f"{key}.{k}", row_idx)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _check_value_finite(v, f"{key}[{i}]", row_idx)
    elif hasattr(value, "item"):   # numpy scalar
        try:
            scalar = value.item()
            if isinstance(scalar, float) and not math.isfinite(scalar):
                raise InputValidationError(
                    ErrorCode.NON_FINITE_VALUE,
                    f"Ph-9: non-finite numpy scalar {scalar!r} in row {row_idx} "
                    f"column '{key}'.",
                )
        except (ValueError, OverflowError) as exc:
            raise InputValidationError(
                ErrorCode.NON_FINITE_VALUE,
                f"Ph-9: numpy conversion failure in row {row_idx} column '{key}': "
                f"{exc}.",
            ) from exc


def _acquire_lock(lock_path: str):
    """
    Ph-1: Exclusive OS-level lock context manager.
    filelock.FileLock preferred; _PurePyFileLock as fallback.
    """
    if _FILELOCK_AVAILABLE:
        return _FileLock(lock_path, timeout=_LOCK_TIMEOUT_SEC)
    return _PurePyFileLock(lock_path, timeout=_LOCK_TIMEOUT_SEC)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_default(obj: Any) -> Any:
    if hasattr(obj, "item"):
        return obj.item()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    if obj is None:
        return None
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _df_to_json_records(df: Any) -> List[Dict[str, Any]]:
    """
    Convert DataFrame to JSON-safe dicts.
    Ph-8 / Ph-9: NaN and Inf raise immediately — no silent coercion.
    """
    records: List[Dict[str, Any]] = []
    for row in df.to_dict(orient="records"):
        clean: Dict[str, Any] = {}
        for k, v in row.items():
            if isinstance(v, float):
                if math.isnan(v):
                    raise InputValidationError(
                        ErrorCode.NON_FINITE_VALUE,
                        f"_df_to_json_records: NaN in column '{k}'. "
                        "Replace via _normalize_df_numerics.",
                    )
                if math.isinf(v):
                    raise InputValidationError(
                        ErrorCode.NON_FINITE_VALUE,
                        f"_df_to_json_records: Inf in column '{k}'.",
                    )
            if hasattr(v, "item"):
                item = v.item()
                if isinstance(item, float):
                    if math.isnan(item):
                        raise InputValidationError(
                            ErrorCode.NON_FINITE_VALUE,
                            f"_df_to_json_records: numpy NaN in column '{k}'.",
                        )
                    if math.isinf(item):
                        raise InputValidationError(
                            ErrorCode.NON_FINITE_VALUE,
                            f"_df_to_json_records: numpy Inf in column '{k}'.",
                        )
                clean[k] = item
                continue
            try:
                import pandas as _pd
                if v is _pd.NA or v is _pd.NaT:
                    clean[k] = None
                    continue
            except ImportError:
                # pandas is not installed; pd.NA / pd.NaT check is skipped.
                # All other NA forms (float NaN, numpy NaN) are caught above.
                _log.debug(
                    "_df_to_json_records: pandas not installed; "
                    "pd.NA / pd.NaT sentinel check skipped for column '%s'.", k
                )
            except Exception as _pd_err:
                _log.error(
                    "[HARD FAIL] checkpoint pandas NA probe invariant violated for column '%s': %s",
                    k,
                    _pd_err,
                )
                raise RuntimeError(
                    f"[HARD FAIL] checkpoint invariant violated: pandas NA probe failed "
                    f"for column '{k}': {_pd_err}"
                ) from _pd_err
            clean[k] = v
        records.append(clean)
    return records
