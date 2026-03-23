"""
test_errors_config.py — Unit tests for src/utils/errors.py and src/utils/config.py

Covers:
  ER-01  All ErrorCode enum values are unique (no duplicates)
  ER-02  AutoMateError.to_dict() produces correct shape
  ER-03  Subclass hierarchy: all typed exceptions extend AutoMateError
  ER-04  NotImplementedError_ uses UNIMPLEMENTED code
  ER-05  UnexpectedBranchError uses UNEXPECTED_BRANCH code
  ER-06  cause is preserved and serialized

  CF-01  All config values are of expected Python types
  CF-02  Risk weights sum to 1.0
  CF-03  Quality weights sum to 1.0
  CF-04  Drift thresholds are ordered: LOW < MODERATE < 1.0
  CF-05  Generator thresholds are ordered: SMALL < LARGE
  CF-06  Generator batch size max is positive
"""
import sys, os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from utils.errors import (
    ErrorCode, AutoMateError,
    DependencyError, InputValidationError, SchemaError,
    PipelineError, CheckpointError,
    NotImplementedError_, UnexpectedBranchError,
)


# ─────────────────────────────────────────────────────────────────────────────
# errors.py tests
# ─────────────────────────────────────────────────────────────────────────────

class TestErrorCode:

    # ER-01: Unique values
    def test_all_codes_are_unique(self):
        values = [e.value for e in ErrorCode]
        assert len(values) == len(set(values)), "ErrorCode contains duplicate values"

    def test_all_codes_are_strings(self):
        for e in ErrorCode:
            assert isinstance(e.value, str), f"{e.name} value is not a string"

    def test_codes_are_uppercase_snake_case(self):
        import re
        for e in ErrorCode:
            assert re.match(r'^[A-Z][A-Z0-9_]*$', e.value), \
                f"ErrorCode {e.name} value '{e.value}' is not UPPER_SNAKE_CASE"


class TestAutoMateError:

    # ER-02: to_dict() shape
    def test_to_dict_has_required_keys(self):
        err = AutoMateError(ErrorCode.EMPTY_DATASET, 'Empty dataset provided')
        d = err.to_dict()
        assert 'error_code' in d
        assert 'message' in d
        assert 'cause' in d

    def test_to_dict_error_code_is_string(self):
        err = AutoMateError(ErrorCode.EMPTY_DATASET, 'msg')
        d = err.to_dict()
        assert isinstance(d['error_code'], str)
        assert d['error_code'] == 'EMPTY_DATASET'

    def test_to_dict_message_matches(self):
        err = AutoMateError(ErrorCode.MISSING_FIELD, 'field X is required')
        d = err.to_dict()
        assert d['message'] == 'field X is required'

    # ER-06: cause preservation
    def test_cause_is_preserved(self):
        original = ValueError('underlying error')
        err = AutoMateError(ErrorCode.PIPELINE_FAILED, 'pipeline failed', cause=original)
        assert err.cause is original

    def test_cause_in_dict_when_set(self):
        original = RuntimeError('root cause')
        err = AutoMateError(ErrorCode.PIPELINE_FAILED, 'msg', cause=original)
        d = err.to_dict()
        assert d['cause'] is not None
        assert 'root cause' in d['cause']

    def test_cause_is_none_when_not_set(self):
        err = AutoMateError(ErrorCode.EMPTY_DATASET, 'msg')
        d = err.to_dict()
        assert d['cause'] is None

    def test_repr_contains_code_and_message(self):
        err = AutoMateError(ErrorCode.TYPE_MISMATCH, 'bad type')
        r = repr(err)
        assert 'TYPE_MISMATCH' in r
        assert 'bad type' in r

    # ER-03: Subclass hierarchy
    def test_dependency_error_is_automate_error(self):
        err = DependencyError(ErrorCode.PANDAS_REQUIRED, 'pandas missing')
        assert isinstance(err, AutoMateError)

    def test_input_validation_error_is_automate_error(self):
        err = InputValidationError(ErrorCode.EMPTY_DATASET, 'empty')
        assert isinstance(err, AutoMateError)

    def test_schema_error_is_automate_error(self):
        err = SchemaError(ErrorCode.INVALID_SCHEMA, 'bad schema')
        assert isinstance(err, AutoMateError)

    def test_pipeline_error_is_automate_error(self):
        err = PipelineError(ErrorCode.PIPELINE_FAILED, 'failure')
        assert isinstance(err, AutoMateError)

    def test_checkpoint_error_is_automate_error(self):
        err = CheckpointError(ErrorCode.HASH_MISMATCH, 'hash mismatch')
        assert isinstance(err, AutoMateError)

    # ER-04: NotImplementedError_
    def test_not_implemented_uses_unimplemented_code(self):
        err = NotImplementedError_('module.function')
        assert err.code == ErrorCode.UNIMPLEMENTED
        assert 'module.function' in err.message

    # ER-05: UnexpectedBranchError
    def test_unexpected_branch_uses_correct_code(self):
        err = UnexpectedBranchError('module.function')
        assert err.code == ErrorCode.UNEXPECTED_BRANCH
        assert 'module.function' in err.message

    # Errors are raiseable
    def test_automate_error_is_exception(self):
        with pytest.raises(AutoMateError):
            raise AutoMateError(ErrorCode.EMPTY_DATASET, 'test raise')

    def test_subclass_is_catchable_as_automate_error(self):
        with pytest.raises(AutoMateError):
            raise InputValidationError(ErrorCode.TYPE_MISMATCH, 'bad type')


# ─────────────────────────────────────────────────────────────────────────────
# config.py tests
# ─────────────────────────────────────────────────────────────────────────────

import utils.config as cfg


class TestConfig:

    # CF-01: All config values have expected types
    def test_mi_max_sample_size_is_int(self):
        assert isinstance(cfg.MI_MAX_SAMPLE_SIZE, int)
        assert cfg.MI_MAX_SAMPLE_SIZE > 0

    def test_mi_lr_c_is_float(self):
        assert isinstance(cfg.MI_LR_C, float)
        assert cfg.MI_LR_C > 0

    def test_drift_thresholds_are_floats(self):
        assert isinstance(cfg.DRIFT_LOW_MAX, float)
        assert isinstance(cfg.DRIFT_MODERATE_MAX, float)

    def test_risk_boundaries_are_floats(self):
        assert isinstance(cfg.RISK_CRITICAL_MIN, float)
        assert isinstance(cfg.RISK_HIGH_MIN, float)
        assert isinstance(cfg.RISK_MEDIUM_MIN, float)

    def test_generator_thresholds_are_ints(self):
        assert isinstance(cfg.GENERATOR_SMALL_THRESHOLD, int)
        assert isinstance(cfg.GENERATOR_LARGE_THRESHOLD, int)

    def test_cache_ttl_is_int(self):
        assert isinstance(cfg.CACHE_TTL_SEC, int)
        assert cfg.CACHE_TTL_SEC > 0

    def test_cache_schema_version_is_string(self):
        assert isinstance(cfg.CACHE_SCHEMA_VERSION, str)
        assert len(cfg.CACHE_SCHEMA_VERSION) > 0

    # CF-02: Risk weights sum to 1.0
    def test_risk_weights_sum_to_one(self):
        total = (
            cfg.RISK_WEIGHT_AUC +
            cfg.RISK_WEIGHT_DRIFT +
            cfg.RISK_WEIGHT_DUPLICATES +
            cfg.RISK_WEIGHT_PROXIMITY
        )
        assert abs(total - 1.0) < 1e-9, f"Risk weights sum to {total}, expected 1.0"

    # CF-03: Quality weights sum to 1.0
    def test_quality_weights_sum_to_one(self):
        total = (
            cfg.QUALITY_WEIGHT_AUC +
            cfg.QUALITY_WEIGHT_DRIFT +
            cfg.QUALITY_WEIGHT_LABEL
        )
        assert abs(total - 1.0) < 1e-9, f"Quality weights sum to {total}, expected 1.0"

    # CF-04: Drift thresholds are ordered
    def test_drift_thresholds_ordered(self):
        assert cfg.DRIFT_LOW_MAX < cfg.DRIFT_MODERATE_MAX < 1.0, \
            "Drift thresholds must satisfy LOW < MODERATE < 1.0"

    # CF-05: Generator thresholds are ordered
    def test_generator_thresholds_ordered(self):
        assert cfg.GENERATOR_SMALL_THRESHOLD < cfg.GENERATOR_LARGE_THRESHOLD, \
            "GENERATOR_SMALL_THRESHOLD must be less than GENERATOR_LARGE_THRESHOLD"

    # CF-06: Batch size max is positive
    def test_generator_batch_size_max_positive(self):
        assert cfg.GENERATOR_BATCH_SIZE_MAX > 0

    def test_reliability_threshold_in_range(self):
        assert 0.0 < cfg.RELIABILITY_THRESHOLD < 1.0

    def test_risk_boundaries_ordered(self):
        assert cfg.RISK_MEDIUM_MIN < cfg.RISK_HIGH_MIN < cfg.RISK_CRITICAL_MIN

    def test_scanner_max_rows_positive(self):
        assert cfg.SCANNER_MAX_ROWS > 0
