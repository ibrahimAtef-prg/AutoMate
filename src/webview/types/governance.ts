/**
 * governance.ts — Auto-generated TypeScript types from JSON Schema
 * Source: leakage_output.schema.json
 *
 * ⚠ DO NOT EDIT MANUALLY.
 * Regenerate with: python3 src/schema/generate_ts_types.py
 *
 * Adding a field to the Python schema will cause this file to update,
 * which will cause TypeScript compilation to fail at any site that
 * doesn't handle the new field — that is the intended behavior.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sub-types
// ─────────────────────────────────────────────────────────────────────────────

export interface PrivacyComponents {
  duplicates_risk: number;
  mi_attack_risk: number;
  distance_similarity_risk: number;
  distribution_drift_risk: number;
}

export interface AttackResults {
  membership_attack_success: number | null;
  reconstruction_risk: number | null;
  nearest_neighbor_leakage: number | null;
}

export interface ThreatDetail {
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  impacted_property: string;
  triggered_by: string[];
  description: string;
}

export interface SensitiveColumnEntry {
  column: string;
  score: number;
  pii_score: number;
  reidentification_risk: number;
  drift_score: number;
  signals: Record<string, number>;
}

export interface OutlierRiskEntry {
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  column: string;
  value: number | null;
  description: string;
}

export interface DatasetIntelligenceRisk {
  score: number | null;
  label: 'low' | 'medium' | 'high' | 'critical' | null;
  breakdown: Record<string, number>;
}

export interface PrivacyRecommendation {
  column: string;
  action: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
}

// ─────────────────────────────────────────────────────────────────────────────
// LeakageOutput — primary contract
// ─────────────────────────────────────────────────────────────────────────────

export interface LeakageOutput {
  risk_level: "low" | "medium" | "high" | "critical" | null;
  privacy_score: number | null;
  privacy_score_reliable: boolean;
  statistical_drift: "low" | "moderate" | "high" | "unknown" | null;
  duplicates_rate: number | null;
  membership_inference_auc: number | null;
  avg_drift_score: number | null;
  top_threats: Record<string, unknown>[];
  threat_details: ThreatDetail[];
  column_drift: Record<string, number>;
  reidentification_risk: Record<string, number>;
  sensitive_column_ranking: SensitiveColumnEntry[];
  has_uncertainty: boolean;
  uncertainty_notes: string[];
  error: string | null;
  _mode: string;
  privacy_components: PrivacyComponents | null;
  attack_results: AttackResults;
  num_cols_analysed: number | null;
  cat_cols_analysed: number | null;
  n_samples: number | null;
  dataset_risk_score: number | null;
  statistical_reliability_score: number | null;
  pii_columns: string[];
  outlier_risk: OutlierRiskEntry[];
  dataset_intelligence_risk: DatasetIntelligenceRisk;
  privacy_recommendations: PrivacyRecommendation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed DashboardData — replaces the `any`-filled dashboard.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Baseline artifact from baseline.py */
export interface BaselineArtifact {
  meta: {
    dataset_source: string;
    row_count: number;
    column_count: number;
    generated_at: string;
  };
  columns: {
    numeric: Record<string, {
      mean: number | null;
      std: number | null;
      min: number | null;
      max: number | null;
      null_ratio: number;
      unique_count: number | null;
    }>;
    categorical: Record<string, {
      unique_count: number;
      null_ratio: number;
      top_values: Array<{ value: string; count: number; ratio: number }>;
    }>;
  };
  correlations: {
    numeric_pearson: Record<string, number>;
    categorical_cramers_v: Record<string, number>;
  };
}

/** Generator output from generator.py */
export interface GeneratorOutput {
  generator_used: string;
  row_count: number;
  samples: Record<string, unknown>[];
  quality_score: number | null;
  warnings: string[];
  label_distribution_applied: Record<string, number> | null;
  /** Metrics are a top-level sibling — never part of LeakageOutput. */
  metrics: PipelineMetrics | null;
}

/**
 * Runtime and throughput metrics emitted alongside pipeline data.
 *
 * Canonical key names (unified across generator.py, leakage_bridge.py, UI):
 * generation_time_ms      — wall time for synthetic data generation only
 *                           (excludes validation, I/O, privacy analysis).
 * total_pipeline_time_ms  — full pipeline wall time including all overhead.
 * throughput_rows_per_sec — rows / generation_time_sec (NOT total time),
 *                           isolating synthesis throughput from pipeline cost.
 */
export interface PipelineMetrics {
  generation_time_ms:       number;
  total_pipeline_time_ms:   number;
  throughput_rows_per_sec:  number;
  rows_analysed:            number;
}

/**
 * Top-level envelope emitted by leakage_bridge.py.
 * Metrics travel alongside schema data, never inside it.
 */
export interface LeakageEnvelope {
  data:    LeakageOutput;
  metrics: PipelineMetrics | null;
}

/** PII scan result from pii_detector.py or data_scanner.py */
export interface ScanReport {
  pii_columns: string[];
  pii_findings: Array<{
    column: string;
    category: string;
    severity: string;
    sample_count: number;
  }>;
  pii_density: number;
  pii_risk: 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  secrets: Record<string, unknown>[];
  sensitive_content: Record<string, unknown>[];
}

/** Checkpoint entry from checkp.py */
export interface CheckpointEntry {
  version: string;
  timestamp: string;
  description: string;
  path: string;
}

/** Full typed dashboard state — replaces DashboardState with all `any` */
export interface DashboardData {
  // Core pipeline outputs (typed)
  leakage:     LeakageOutput | null;
  baseline:    BaselineArtifact | null;
  result:      GeneratorOutput | null;
  scanReport:  ScanReport | null;
  ast:         Record<string, unknown> | null;
  cp:          CheckpointEntry | null;
  // Convenience aliases (kept for backward compat)
  profile:     BaselineArtifact | null;
  generator:   GeneratorOutput | null;
  checkpoint:  CheckpointEntry | null;
  // Optional governance modules
  attackReport:   Record<string, unknown> | null;
  knowledgeGraph: Record<string, unknown> | null;
  lineage:        Record<string, unknown> | null;
  intelligence:   Record<string, unknown> | null;
  // VS Code webview URI for Chart.js
  chartUri: string;
  /**
   * Runtime metrics — decoupled from LeakageOutput schema contract.
   * Populated from the "metrics" key of the leakage_bridge envelope.
   * UI may display these but must NOT use them for any logic or gating.
   */
  pipelineMetrics: PipelineMetrics | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime validation guard
// ─────────────────────────────────────────────────────────────────────────────

/** Required fields that must be present and non-null for the dashboard to render. */
const REQUIRED_LEAKAGE_FIELDS: ReadonlyArray<keyof LeakageOutput> = [
  'risk_level',
  'privacy_score',
  'privacy_score_reliable',
  'statistical_drift',
  'duplicates_rate',
  'membership_inference_auc',
  'avg_drift_score',
  'column_drift',
  'threat_details',
  'privacy_components',
  'dataset_risk_score',
  'pii_columns',
  'sensitive_column_ranking',
] as const;

export interface ValidationResult {
  valid: boolean;
  missingFields: string[];
  errors: string[];
}

/**
 * Validate a raw backend payload against the LeakageOutput contract.
 * Call this before passing data to any render function.
 * Returns a ValidationResult — never throws.
 */
export function validateLeakageOutput(raw: unknown): ValidationResult {
  const result: ValidationResult = { valid: true, missingFields: [], errors: [] };

  if (raw === null || typeof raw !== 'object') {
    result.valid = false;
    result.errors.push('Payload is not an object');
    return result;
  }

  const obj = raw as Record<string, unknown>;

  for (const key of REQUIRED_LEAKAGE_FIELDS) {
    if (!(key in obj)) {
      result.missingFields.push(key);
    }
  }

  // Range checks
  const rangeChecks: Array<[string, number, number]> = [
    ['privacy_score', 0, 1],
    ['duplicates_rate', 0, 1],
    ['membership_inference_auc', 0, 1],
    ['dataset_risk_score', 0, 100],
    ['statistical_reliability_score', 0, 1],
  ];
  for (const [field, lo, hi] of rangeChecks) {
    const v = obj[field];
    if (v !== null && v !== undefined && typeof v === 'number' && (v < lo || v > hi)) {
      result.errors.push(`Field '${field}' value ${v} outside [${lo}, ${hi}]`);
    }
  }

  if (result.missingFields.length > 0 || result.errors.length > 0) {
    result.valid = false;
  }

  return result;
}

/**
 * Cast a validated payload to LeakageOutput.
 * Only call this after validateLeakageOutput() returns valid=true.
 */
export function castLeakageOutput(raw: Record<string, unknown>): LeakageOutput {
  return raw as unknown as LeakageOutput;
}

/**
 * Validate a raw metrics object from the pipeline sidecar.
 *
 * Returns true iff the object is non-null, has the canonical numeric fields,
 * and all numeric fields are finite (no NaN, no ±Infinity).
 *
 * Canonical keys (unified across all layers):
 *   generation_time_ms      — wall time for generation only
 *   total_pipeline_time_ms  — full pipeline wall time
 *   throughput_rows_per_sec — rows / generation_time_sec
 */
export function validateMetrics(m: unknown): boolean {
  if (m === null || m === undefined || typeof m !== 'object') {
    return false;
  }
  const obj = m as Record<string, unknown>;

  if (typeof obj['generation_time_ms']      !== 'number') { return false; }
  if (typeof obj['total_pipeline_time_ms']  !== 'number') { return false; }
  if (typeof obj['throughput_rows_per_sec'] !== 'number') { return false; }

  // All numeric fields must be finite — no NaN, no ±Infinity
  const numericFields = [
    obj['generation_time_ms'],
    obj['total_pipeline_time_ms'],
    obj['throughput_rows_per_sec'],
  ];
  for (const v of numericFields) {
    if (typeof v === 'number' && !Number.isFinite(v)) { return false; }
  }

  return true;
}
