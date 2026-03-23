#!/usr/bin/env python3
"""
generate_ts_types.py — Generates TypeScript types from the JSON Schema.

Usage:
    python3 src/schema/generate_ts_types.py

Output:
    src/webview/types/governance.ts   ← replaces the `any`-filled dashboard.ts

After running, the TypeScript build will fail at any site that uses a field
not declared in the schema — that is the intended behavior.
"""

from __future__ import annotations
import json
import os
import sys

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "leakage_output.schema.json")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "webview", "types", "governance.ts")


def _json_type_to_ts(type_def: dict, indent: int = 0) -> str:
    """Convert a JSON Schema type definition to a TypeScript type string."""
    pad = "  " * indent

    if "enum" in type_def:
        literals = [f'"{v}"' if isinstance(v, str) else "null" for v in type_def["enum"]]
        return " | ".join(literals)

    t = type_def.get("type", "any")

    if isinstance(t, list):
        # e.g. ["number", "null"] → number | null
        parts = []
        for pt in t:
            if pt == "null":
                parts.append("null")
            elif pt == "number":
                parts.append("number")
            elif pt == "integer":
                parts.append("number")
            elif pt == "string":
                parts.append("string")
            elif pt == "boolean":
                parts.append("boolean")
            elif pt == "array":
                items = type_def.get("items", {})
                parts.append(f"Array<{_json_type_to_ts(items)}>")
            elif pt == "object":
                parts.append("Record<string, unknown>")
        return " | ".join(parts)

    if t == "object":
        props = type_def.get("properties", {})
        if not props:
            additional = type_def.get("additionalProperties", {})
            if additional:
                val_type = _json_type_to_ts(additional)
                return f"Record<string, {val_type}>"
            return "Record<string, unknown>"
        lines = ["{"]
        req = set(type_def.get("required", []))
        for pname, pdef in props.items():
            opt = "?" if pname not in req else ""
            ts_type = _json_type_to_ts(pdef, indent + 1)
            lines.append(f"{pad}  {pname}{opt}: {ts_type};")
        lines.append(f"{pad}}}")
        return "\n".join(lines)

    if t == "array":
        items = type_def.get("items", {})
        return f"Array<{_json_type_to_ts(items, indent)}>"

    mapping = {
        "string": "string",
        "number": "number",
        "integer": "number",
        "boolean": "boolean",
        "null": "null",
    }
    return mapping.get(t, "unknown")


def generate(schema_path: str, output_path: str) -> None:
    with open(schema_path, encoding="utf-8") as f:
        schema = json.load(f)

    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    title = schema.get("title", "GeneratedSchema")

    lines = [
        "/**",
        f" * governance.ts — Auto-generated TypeScript types from JSON Schema",
        f" * Source: {os.path.basename(schema_path)}",
        f" *",
        f" * ⚠ DO NOT EDIT MANUALLY.",
        f" * Regenerate with: python3 src/schema/generate_ts_types.py",
        f" *",
        f" * Adding a field to the Python schema will cause this file to update,",
        f" * which will cause TypeScript compilation to fail at any site that",
        f" * doesn't handle the new field — that is the intended behavior.",
        f" */",
        "",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "// Sub-types",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "",
        "export interface PrivacyComponents {",
        "  duplicates_risk: number;",
        "  mi_attack_risk: number;",
        "  distance_similarity_risk: number;",
        "  distribution_drift_risk: number;",
        "}",
        "",
        "export interface AttackResults {",
        "  membership_attack_success: number | null;",
        "  reconstruction_risk: number | null;",
        "  nearest_neighbor_leakage: number | null;",
        "}",
        "",
        "export interface ThreatDetail {",
        "  name: string;",
        "  severity: 'low' | 'medium' | 'high' | 'critical';",
        "  confidence: number;",
        "  impacted_property: string;",
        "  triggered_by: string[];",
        "  description: string;",
        "}",
        "",
        "export interface SensitiveColumnEntry {",
        "  column: string;",
        "  score: number;",
        "  pii_score: number;",
        "  reidentification_risk: number;",
        "  drift_score: number;",
        "  signals: string[];",
        "}",
        "",
        "export interface OutlierRiskEntry {",
        "  name: string;",
        "  severity: 'low' | 'medium' | 'high' | 'critical';",
        "  column: string;",
        "  value: number | null;",
        "  description: string;",
        "}",
        "",
        "export interface DatasetIntelligenceRisk {",
        "  score: number | null;",
        "  label: 'low' | 'medium' | 'high' | 'critical' | null;",
        "  breakdown: Record<string, number>;",
        "}",
        "",
        "export interface PrivacyRecommendation {",
        "  column: string;",
        "  action: string;",
        "  reason: string;",
        "  urgency: 'low' | 'medium' | 'high' | 'critical';",
        "}",
        "",
        "// ─────────────────────────────────────────────────────────────────────────────",
        f"// {title} — primary contract",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "",
        f"export interface {title} {{",
    ]

    # Emit each property with its TypeScript type
    special_types: dict[str, str] = {
        "privacy_components":       "PrivacyComponents | null",
        "attack_results":           "AttackResults",
        "threat_details":           "ThreatDetail[]",
        "sensitive_column_ranking": "SensitiveColumnEntry[]",
        "outlier_risk":             "OutlierRiskEntry[]",
        "dataset_intelligence_risk":"DatasetIntelligenceRisk",
        "privacy_recommendations":  "PrivacyRecommendation[]",
        "column_drift":             "Record<string, number>",
        "reidentification_risk":    "Record<string, number>",
        "top_threats":              "Record<string, unknown>[]",
        "uncertainty_notes":        "string[]",
        "pii_columns":              "string[]",
    }

    for pname, pdef in props.items():
        opt = "" if pname in required else "?"
        if pname in special_types:
            ts_type = special_types[pname]
        else:
            ts_type = _json_type_to_ts(pdef)
        lines.append(f"  {pname}{opt}: {ts_type};")

    lines += [
        "}",
        "",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "// Typed DashboardData — replaces the `any`-filled dashboard.ts",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "",
        "/** Baseline artifact from baseline.py */",
        "export interface BaselineArtifact {",
        "  meta: {",
        "    dataset_source: string;",
        "    row_count: number;",
        "    column_count: number;",
        "    generated_at: string;",
        "  };",
        "  columns: {",
        "    numeric: Record<string, {",
        "      mean: number | null;",
        "      std: number | null;",
        "      min: number | null;",
        "      max: number | null;",
        "      null_ratio: number;",
        "      unique_count: number | null;",
        "    }>;",
        "    categorical: Record<string, {",
        "      unique_count: number;",
        "      null_ratio: number;",
        "      top_values: Array<{ value: string; count: number; ratio: number }>;",
        "    }>;",
        "  };",
        "  correlations: {",
        "    numeric_pearson: Record<string, number>;",
        "    categorical_cramers_v: Record<string, number>;",
        "  };",
        "}",
        "",
        "/** Generator output from generator.py */",
        "export interface GeneratorOutput {",
        "  generator_used: string;",
        "  row_count: number;",
        "  samples: Record<string, unknown>[];",
        "  quality_score: number | null;",
        "  warnings: string[];",
        "}",
        "",
        "/** PII scan result from pii_detector.py or data_scanner.py */",
        "export interface ScanReport {",
        "  pii_columns: string[];",
        "  pii_findings: Array<{",
        "    column: string;",
        "    category: string;",
        "    severity: string;",
        "    sample_count: number;",
        "  }>;",
        "  pii_density: number;",
        "  pii_risk: 'low' | 'medium' | 'high' | 'critical';",
        "  risk_score: number;",
        "  secrets: Record<string, unknown>[];",
        "  sensitive_content: Record<string, unknown>[];",
        "}",
        "",
        "/** Checkpoint entry from checkp.py */",
        "export interface CheckpointEntry {",
        "  version: string;",
        "  timestamp: string;",
        "  description: string;",
        "  path: string;",
        "}",
        "",
        "/** Full typed dashboard state — replaces DashboardState with all `any` */",
        "export interface DashboardData {",
        "  // Core pipeline outputs (typed)",
        "  leakage:     LeakageOutput | null;",
        "  baseline:    BaselineArtifact | null;",
        "  result:      GeneratorOutput | null;",
        "  scanReport:  ScanReport | null;",
        "  ast:         Record<string, unknown> | null;",
        "  cp:          CheckpointEntry | null;",
        "  // Convenience aliases (kept for backward compat)",
        "  profile:     BaselineArtifact | null;",
        "  generator:   GeneratorOutput | null;",
        "  checkpoint:  CheckpointEntry | null;",
        "  // Optional governance modules",
        "  attackReport:   Record<string, unknown> | null;",
        "  knowledgeGraph: Record<string, unknown> | null;",
        "  lineage:        Record<string, unknown> | null;",
        "  intelligence:   Record<string, unknown> | null;",
        "  // VS Code webview URI for Chart.js",
        "  chartUri: string;",
        "}",
        "",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "// Runtime validation guard",
        "// ─────────────────────────────────────────────────────────────────────────────",
        "",
        "/** Required fields that must be present and non-null for the dashboard to render. */",
        "const REQUIRED_LEAKAGE_FIELDS: ReadonlyArray<keyof LeakageOutput> = [",
        "  'risk_level',",
        "  'privacy_score',",
        "  'privacy_score_reliable',",
        "  'statistical_drift',",
        "  'duplicates_rate',",
        "  'membership_inference_auc',",
        "  'avg_drift_score',",
        "  'column_drift',",
        "  'threat_details',",
        "  'privacy_components',",
        "  'dataset_risk_score',",
        "  'pii_columns',",
        "  'sensitive_column_ranking',",
        "] as const;",
        "",
        "export interface ValidationResult {",
        "  valid: boolean;",
        "  missingFields: string[];",
        "  errors: string[];",
        "}",
        "",
        "/**",
        " * Validate a raw backend payload against the LeakageOutput contract.",
        " * Call this before passing data to any render function.",
        " * Returns a ValidationResult — never throws.",
        " */",
        "export function validateLeakageOutput(raw: unknown): ValidationResult {",
        "  const result: ValidationResult = { valid: true, missingFields: [], errors: [] };",
        "",
        "  if (raw === null || typeof raw !== 'object') {",
        "    result.valid = false;",
        "    result.errors.push('Payload is not an object');",
        "    return result;",
        "  }",
        "",
        "  const obj = raw as Record<string, unknown>;",
        "",
        "  for (const key of REQUIRED_LEAKAGE_FIELDS) {",
        "    if (!(key in obj)) {",
        "      result.missingFields.push(key);",
        "    }",
        "  }",
        "",
        "  // Range checks",
        "  const rangeChecks: Array<[string, number, number]> = [",
        "    ['privacy_score', 0, 1],",
        "    ['duplicates_rate', 0, 1],",
        "    ['membership_inference_auc', 0, 1],",
        "    ['dataset_risk_score', 0, 100],",
        "    ['statistical_reliability_score', 0, 1],",
        "  ];",
        "  for (const [field, lo, hi] of rangeChecks) {",
        "    const v = obj[field];",
        "    if (v !== null && v !== undefined && typeof v === 'number' && (v < lo || v > hi)) {",
        "      result.errors.push(`Field '${field}' value ${v} outside [${lo}, ${hi}]`);",
        "    }",
        "  }",
        "",
        "  if (result.missingFields.length > 0 || result.errors.length > 0) {",
        "    result.valid = false;",
        "  }",
        "",
        "  return result;",
        "}",
        "",
        "/**",
        " * Cast a validated payload to LeakageOutput.",
        " * Only call this after validateLeakageOutput() returns valid=true.",
        " */",
        "export function castLeakageOutput(raw: Record<string, unknown>): LeakageOutput {",
        "  return raw as unknown as LeakageOutput;",
        "}",
        "",
    ]

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    sys.stdout.write(f"[codegen] Generated: {output_path}" + "\n")
    sys.stdout.write(f"[codegen] {len(props)} top-level properties in LeakageOutput\n")


if __name__ == "__main__":
    generate(SCHEMA_PATH, OUTPUT_PATH)
