"""
errors.py — Centralized Error Codes and Custom Exceptions for AutoMate Aurora

PURPOSE
-------
Single source of truth for all domain-specific exceptions raised across the
pipeline.  Every exception carries a structured ErrorCode so callers can branch
programmatically without parsing error message strings.

ERROR MODEL
-----------
CORE modules (checkp, generator, leakage_bridge math, governance_schema) use
fail-fast: they raise a typed AutoMateError subclass on any violation.  No
warnings, no fallback values, no silent correction.

EDGE modules (pii_detector, policy_engine, knowledge_graph, UI) use
warn-and-continue: they emit _log.warning / warnings.warn and return a safe
default.  No exceptions propagate to callers.

BOUNDARY
--------
At every CORE → EDGE transition the calling code asserts the input is valid
before dispatching to the edge function.  Edge code never calls core code with
invalid data (the inverse direction is forbidden).

USAGE
-----
    from utils.errors import AutoMateError, ErrorCode
    from utils.errors import InputValidationError, PipelineError, CheckpointError

    # CORE: fail-fast
    raise InputValidationError(
        ErrorCode.NON_FINITE_VALUE,
        f"NaN detected in column '{col}' before checkpoint write",
    )

    # EDGE: warn and continue
    _log.warning("pii_detector: low confidence for column %s (%.2f)", col, conf)
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


# ─── Error code registry ─────────────────────────────────────────────────────

class ErrorCode(str, Enum):
    """Machine-readable error codes.  Each constant maps to a unique failure mode."""

    # ── Dependency errors ───────────────────────────────────────────────────
    PANDAS_REQUIRED         = "PANDAS_REQUIRED"
    NUMPY_REQUIRED          = "NUMPY_REQUIRED"
    YAML_REQUIRED           = "YAML_REQUIRED"
    OPENPYXL_REQUIRED       = "OPENPYXL_REQUIRED"
    SCHEMA_MODULE_REQUIRED  = "SCHEMA_MODULE_REQUIRED"

    # ── Input / validation errors ───────────────────────────────────────────
    EMPTY_DATASET           = "EMPTY_DATASET"
    INVALID_SCHEMA          = "INVALID_SCHEMA"
    MISSING_FIELD           = "MISSING_FIELD"
    TYPE_MISMATCH           = "TYPE_MISMATCH"
    OUT_OF_RANGE            = "OUT_OF_RANGE"
    NON_FINITE_VALUE        = "NON_FINITE_VALUE"
    INVALID_FILE_PATH       = "INVALID_FILE_PATH"
    UNSUPPORTED_FORMAT      = "UNSUPPORTED_FORMAT"
    INVALID_DISTRIBUTION    = "INVALID_DISTRIBUTION"    # label distribution sums / negatives
    INVALID_CONSTRAINT      = "INVALID_CONSTRAINT"      # contradictory or unsatisfiable constraint
    NEGATIVE_TIME           = "NEGATIVE_TIME"           # time argument is negative / non-finite
    METRIC_INVARIANT        = "METRIC_INVARIANT"        # timing or throughput invariant violated

    # ── Pipeline errors ─────────────────────────────────────────────────────
    PIPELINE_FAILED         = "PIPELINE_FAILED"
    SCHEMA_VALIDATION       = "SCHEMA_VALIDATION"
    CONSTRAINT_FAILURE      = "CONSTRAINT_FAILURE"
    ENGINE_NOT_FITTED       = "ENGINE_NOT_FITTED"       # sample() called before fit()
    OUTPUT_INVALID          = "OUTPUT_INVALID"          # generated output fails contract
    ENVELOPE_INVALID        = "ENVELOPE_INVALID"        # output envelope missing/malformed

    # ── Checkpoint errors ───────────────────────────────────────────────────
    CHECKPOINT_CORRUPT      = "CHECKPOINT_CORRUPT"
    LOCK_TIMEOUT            = "LOCK_TIMEOUT"
    TXID_COLLISION          = "TXID_COLLISION"
    HASH_MISMATCH           = "HASH_MISMATCH"
    LINE_COUNT_MISMATCH     = "LINE_COUNT_MISMATCH"
    COMMIT_WRONG_STATUS     = "COMMIT_WRONG_STATUS"
    ROWS_EXCEED_REQUEST     = "ROWS_EXCEED_REQUEST"

    # ── Module / execution errors ───────────────────────────────────────────
    UNIMPLEMENTED           = "UNIMPLEMENTED"
    UNEXPECTED_BRANCH       = "UNEXPECTED_BRANCH"
    IMPORT_PATH_MISSING     = "IMPORT_PATH_MISSING"


# ─── Base exception ───────────────────────────────────────────────────────────

class AutoMateError(Exception):
    """
    Base class for all domain-specific exceptions in AutoMate Aurora.

    Attributes
    ----------
    code    : ErrorCode — machine-readable discriminant for programmatic branching
    message : str       — human-readable description of the failure
    cause   : Exception — original exception, if this wraps another error
    """

    def __init__(
        self,
        code:    ErrorCode,
        message: str,
        cause:   Optional[Exception] = None,
    ) -> None:
        super().__init__(message)
        self.code    = code
        self.message = message
        self.cause   = cause

    def to_dict(self) -> dict:
        return {
            "error_code": self.code.value,
            "message":    self.message,
            "cause":      str(self.cause) if self.cause else None,
        }

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code.value!r}, message={self.message!r})"


# ─── Typed subclasses ────────────────────────────────────────────────────────

class DependencyError(AutoMateError):
    """Raised when a required third-party dependency is not installed."""


class InputValidationError(AutoMateError):
    """
    Raised when input data fails structural or value-level validation.

    Used for: NaN/Inf in data, out-of-range values, type mismatches,
    invalid distributions, missing required fields.
    """


class SchemaError(AutoMateError):
    """
    Raised when a schema definition is structurally invalid or contradictory.

    Used by: governance_schema, generator baseline validation.
    """


class PipelineError(AutoMateError):
    """
    Raised when a pipeline execution step fails in an unrecoverable way.

    Used for: engine not fitted, output contract violations, envelope errors,
    constraint acceptance rate floor hit.
    """


class CheckpointError(AutoMateError):
    """
    Raised when the checkpoint store is corrupt or violates integrity invariants.

    Used for: hash mismatches, line count mismatches, TXID collision,
    wrong status transitions, WAL recovery failures.
    """


class NotImplementedError_(AutoMateError):  # noqa: N818  (avoids shadowing builtin)
    """Raised in branches that are explicitly not yet implemented."""

    def __init__(self, location: str) -> None:
        super().__init__(
            code    = ErrorCode.UNIMPLEMENTED,
            message = f"Explicitly not implemented: {location}",
        )


class UnexpectedBranchError(AutoMateError):
    """Raised when execution reaches a branch that should be unreachable."""

    def __init__(self, location: str) -> None:
        super().__init__(
            code    = ErrorCode.UNEXPECTED_BRANCH,
            message = f"Unexpected execution path reached: {location}",
        )
