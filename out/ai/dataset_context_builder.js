"use strict";
/**
 * dataset_context_builder.ts — Phase 5: Dataset Context Builder
 *
 * Constructs a richly structured DatasetContext object from all
 * pipeline outputs (baseline, leakage, scan, graph, alerts).
 *
 * This is the single source of truth the AI agent uses to reason
 * about the dataset. Every value here traces back to a real pipeline
 * measurement — never fabricated.
 *
 * Consumers:
 *   - openrouter_client.ts  (system prompt construction)
 *   - AgentTools             (tool function implementations)
 *   - ai_agent_tests.ts      (validation)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentTools = void 0;
exports.buildDatasetContext = buildDatasetContext;
exports.formatContextForLLM = formatContextForLLM;
exports.buildStructuredDatasetContext = buildStructuredDatasetContext;
exports.formatStructuredDatasetContext = formatStructuredDatasetContext;
exports.getValidNumbers = getValidNumbers;
const alert_store_1 = require("../security/alert_store");
// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────
function buildDatasetContext(ctx) {
    const b = ctx.baseline ?? {};
    const l = ctx.leakage ?? {};
    const r = ctx.result ?? {};
    const sc = ctx.scanReport ?? {};
    const g = ctx.graph ?? {};
    const numCols = Object.keys(b.columns?.numeric ?? {});
    const catCols = Object.keys(b.columns?.categorical ?? {});
    const allCols = [...numCols, ...catCols];
    const meta = b.meta ?? {};
    const profile = (ctx.ast?.dataset ?? ctx.ast ?? {}).profile ?? {};
    // ── Dataset summary ───────────────────────────────────────────────────
    const summary = {
        rows: meta.row_count ?? profile.row_count_estimate ?? null,
        columns: (allCols.length || meta.column_count) ?? 0,
        numeric_columns: numCols.length,
        categorical_columns: catCols.length,
        numeric_column_names: numCols,
        categorical_column_names: catCols,
        source_file: meta.dataset_source ?? null,
        generator_used: r.generator_used ?? null,
        synthetic_rows: r.row_count ?? null,
    };
    console.log("[AutoMate] context rows:", summary.rows);
    // ── Risk metrics ──────────────────────────────────────────────────────
    const dir = l.dataset_intelligence_risk ?? {};
    const ps = l.privacy_score;
    const risk = {
        dataset_risk_score: l.dataset_risk_score ?? null,
        dataset_intelligence_risk: dir.score ?? null,
        intelligence_risk_label: dir.label ?? null,
        privacy_score: ps ?? null,
        privacy_score_pct: ps != null ? (ps * 100).toFixed(1) + '%' : null,
        membership_inference_auc: l.membership_inference_auc ?? null,
        duplicates_rate: l.duplicates_rate ?? null,
        statistical_drift: l.statistical_drift ?? null,
        avg_drift_score: l.avg_drift_score ?? null,
        risk_level: l.risk_level ?? null,
        statistical_reliability_score: l.statistical_reliability_score ?? null,
    };
    // ── Privacy components ────────────────────────────────────────────────
    const pc = l.privacy_components
        ? {
            duplicates_risk: l.privacy_components.duplicates_risk ?? 0,
            mi_attack_risk: l.privacy_components.mi_attack_risk ?? 0,
            distance_similarity_risk: l.privacy_components.distance_similarity_risk ?? 0,
            distribution_drift_risk: l.privacy_components.distribution_drift_risk ?? 0,
        }
        : null;
    // ── PII columns ───────────────────────────────────────────────────────
    const piiCols = [
        ...(sc.high_risk_columns ?? []),
        ...((sc.pii_findings ?? []).map((f) => f.column).filter(Boolean)),
    ];
    const piiColsUnique = [...new Set(piiCols)];
    // ── Sensitive column ranking ──────────────────────────────────────────
    const sensitiveColumns = (l.sensitive_column_ranking ?? [])
        .slice(0, 12)
        .map((item) => ({
        column: item.column,
        score: item.score ?? 0,
        pii_score: item.signals?.pii_score ?? 0,
        reidentification_risk: item.signals?.reidentification_risk ?? 0,
        drift_score: item.signals?.drift_score ?? 0,
    }));
    // ── Per-column stats ──────────────────────────────────────────────────
    const reidRisk = l.reidentification_risk ?? {};
    const colDrift = l.column_drift ?? {};
    const columnStats = [];
    for (const [col, stats] of Object.entries(b.columns?.numeric ?? {})) {
        const s = stats;
        columnStats.push({
            name: col, type: 'numeric',
            min: s.min, max: s.max,
            mean: s.mean, std: s.std,
            null_ratio: s.null_ratio,
            drift_score: colDrift[col],
            reidentification_risk: reidRisk[col],
            is_pii: piiColsUnique.includes(col),
        });
    }
    for (const [col, stats] of Object.entries(b.columns?.categorical ?? {})) {
        const s = stats;
        const topVals = s.top_values
            ? Object.entries(s.top_values)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([v]) => v)
            : [];
        columnStats.push({
            name: col, type: 'categorical',
            null_ratio: s.null_ratio,
            unique_ratio: s.unique_ratio,
            top_values: topVals,
            drift_score: colDrift[col],
            reidentification_risk: reidRisk[col],
            is_pii: piiColsUnique.includes(col),
        });
    }
    // ── Anomaly detection ─────────────────────────────────────────────────
    const anomalies = [];
    // High drift columns
    for (const [col, drift] of Object.entries(colDrift).sort(([, a], [, b]) => b - a).slice(0, 8)) {
        if (drift > 0.15) {
            anomalies.push({
                column: col, issue: 'Distribution drift',
                severity: drift > 0.30 ? 'high' : 'medium',
                detail: `JS-divergence=${drift.toFixed(4)} — synthetic distribution diverges significantly from original`,
            });
        }
    }
    // High null rate columns
    for (const cs of columnStats) {
        if ((cs.null_ratio ?? 0) > 0.30) {
            anomalies.push({
                column: cs.name, issue: 'High missing rate',
                severity: (cs.null_ratio ?? 0) > 0.60 ? 'high' : 'medium',
                detail: `null_ratio=${((cs.null_ratio ?? 0) * 100).toFixed(1)}% — column has excessive missing values`,
            });
        }
    }
    // High std / mean ratio (high coefficient of variation → skewed)
    for (const cs of columnStats) {
        if (cs.type === 'numeric' && cs.mean != null && cs.std != null && Math.abs(cs.mean) > 0) {
            const cv = Math.abs(cs.std / cs.mean);
            if (cv > 3.0) {
                anomalies.push({
                    column: cs.name, issue: 'High variance / skewed distribution',
                    severity: 'medium',
                    detail: `CV=${cv.toFixed(2)} (std/mean) — likely skewed or contains extreme outliers`,
                });
            }
        }
    }
    // Outlier exposure from leakage
    for (const ot of (l.outlier_risk ?? []).slice(0, 5)) {
        anomalies.push({
            column: ot.column, issue: 'Outlier exposure risk',
            severity: (ot.severity === 'critical' || ot.severity === 'high') ? 'high' : 'medium',
            detail: `value=${ot.value}, ${ot.extreme_ratio}× IQR fence — individual may be re-identifiable via outlier`,
        });
    }
    // ── Cleaning suggestions ──────────────────────────────────────────────
    const cleaningSuggestions = [];
    for (const cs of columnStats) {
        const nr = cs.null_ratio ?? 0;
        if (nr > 0.60) {
            cleaningSuggestions.push({ column: cs.name, issue: `${(nr * 100).toFixed(0)}% missing`, action: 'Consider dropping this column — missing rate is too high for reliable imputation', priority: 'high' });
        }
        else if (nr > 0.30) {
            cleaningSuggestions.push({ column: cs.name, issue: `${(nr * 100).toFixed(0)}% missing`, action: cs.type === 'numeric' ? 'Impute with median or model-based imputation' : 'Impute with mode or "Unknown" category', priority: 'medium' });
        }
    }
    for (const an of anomalies) {
        if (an.issue === 'High variance / skewed distribution') {
            cleaningSuggestions.push({ column: an.column, issue: 'Extreme skew / outliers', action: 'Apply log1p transform or IQR-based clipping to reduce outlier impact', priority: 'medium' });
        }
        if (an.issue === 'Outlier exposure risk') {
            cleaningSuggestions.push({ column: an.column, issue: 'Individual outlier exposure', action: 'Clip to 99th percentile or add Laplace noise (differential privacy)', priority: 'high' });
        }
    }
    for (const col of piiColsUnique) {
        const scEntry = sensitiveColumns.find(s => s.column === col);
        if (scEntry && scEntry.reidentification_risk > 0.6) {
            cleaningSuggestions.push({ column: col, issue: `Re-identification risk ${(scEntry.reidentification_risk * 100).toFixed(0)}%`, action: 'Apply k-anonymity generalisation, or replace with hashed/tokenised surrogate', priority: 'high' });
        }
        else {
            cleaningSuggestions.push({ column: col, issue: 'PII detected', action: 'Mask with format-preserving pseudonymisation or remove from dataset', priority: 'medium' });
        }
    }
    // ── Governance actions ────────────────────────────────────────────────
    const govActions = [];
    // Based on sensitive column ranking
    for (const sc of sensitiveColumns.slice(0, 6)) {
        if (sc.pii_score > 0.7) {
            govActions.push({ column: sc.column, action: 'Mask or tokenise', reason: `PII score ${(sc.pii_score * 100).toFixed(0)}% — direct personal identifier`, urgency: 'high' });
        }
        if (sc.reidentification_risk > 0.7) {
            govActions.push({ column: sc.column, action: 'Apply k-anonymity or suppress', reason: `Re-identification risk ${(sc.reidentification_risk * 100).toFixed(0)}% — quasi-identifier combination`, urgency: 'critical' });
        }
    }
    // Based on dir score
    if (dir.score != null && dir.score >= 70) {
        govActions.push({ column: 'DATASET', action: 'Mandatory privacy impact assessment', reason: `Dataset intelligence risk ${dir.score.toFixed(0)}/100 — exceeds governance threshold`, urgency: 'critical' });
    }
    // Remove duplicate actions
    const govActionsUnique = govActions.filter((a, i, arr) => i === arr.findIndex(b => b.column === a.column && b.action === a.action));
    // ── Threats ───────────────────────────────────────────────────────────
    const threats = (l.threat_details ?? l.top_threats ?? []).map((t) => ({
        name: t.name,
        severity: t.severity,
        confidence: t.confidence ?? 0,
        description: t.description ?? '',
        triggered_by: t.triggered_by ?? [],
    }));
    // ── Top correlations ──────────────────────────────────────────────────
    const topCorr = (g.top_correlations ?? []).slice(0, 8).map((c) => ({
        cols: c.cols,
        pearson: c.pearson,
        strength: c.strength,
    }));
    // ── Recent alerts ──────────────────────────────────────────────────────
    const recentAlerts = (0, alert_store_1.getRecentAlerts)(10);
    const hasData = summary.columns > 0 || Object.keys(colDrift).length > 0 || recentAlerts.length > 0;
    return {
        dataset_summary: summary,
        risk_metrics: risk,
        privacy_components: pc,
        pii_columns: piiColsUnique,
        sensitive_columns: sensitiveColumns,
        column_stats: columnStats,
        column_drift: colDrift,
        anomalies,
        cleaning_suggestions: cleaningSuggestions,
        governance_actions: govActionsUnique,
        threats,
        top_correlations: topCorr,
        recent_alerts: recentAlerts,
        has_data: hasData,
        built_at: new Date().toISOString(),
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Agent Tool functions — Part 9
// These are the "tools" available to the AI agent.  Each returns a clean
// JSON-serialisable object derived entirely from a DatasetContext.
// ─────────────────────────────────────────────────────────────────────────────
exports.AgentTools = {
    get_dataset_summary(ctx) {
        return ctx.dataset_summary;
    },
    get_sensitive_columns(ctx) {
        return ctx.sensitive_columns;
    },
    get_privacy_metrics(ctx) {
        return {
            risk_metrics: ctx.risk_metrics,
            privacy_components: ctx.privacy_components,
            threats: ctx.threats,
        };
    },
    get_pii_findings(ctx) {
        return {
            pii_columns: ctx.pii_columns,
            cleaning_suggestions: ctx.cleaning_suggestions.filter(s => ctx.pii_columns.includes(s.column)),
            governance_actions: ctx.governance_actions,
        };
    },
    get_recent_alerts(ctx) {
        return ctx.recent_alerts;
    },
    get_anomalies(ctx) {
        return ctx.anomalies;
    },
    get_column_stats(ctx, columnName) {
        if (columnName) {
            return ctx.column_stats.filter(c => c.name === columnName);
        }
        return ctx.column_stats;
    },
    get_sql_schema(ctx) {
        return {
            table: ctx.dataset_summary.source_file?.replace(/[^a-zA-Z0-9_]/g, '_') ?? 'dataset',
            columns: ctx.column_stats.map(c => ({
                name: c.name,
                type: c.type === 'numeric' ? 'NUMERIC' : 'VARCHAR',
                nullable: (c.null_ratio ?? 0) > 0,
                is_pii: c.is_pii ?? false,
            })),
        };
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Format context as compact text block for LLM injection
// ─────────────────────────────────────────────────────────────────────────────
function formatContextForLLM(ctx) {
    const lines = [];
    const s = ctx.dataset_summary;
    const r = ctx.risk_metrics;
    lines.push('## DATASET ANALYSIS CONTEXT');
    lines.push('(All values are real pipeline measurements — do NOT invent numbers not present here.)');
    lines.push('');
    // Summary
    lines.push('### Dataset Summary');
    lines.push(`  Rows: ${s.rows ?? 'unknown'} | Columns: ${s.columns}`);
    lines.push(`  Numeric  (${s.numeric_columns}): ${s.numeric_column_names.join(', ') || 'none'}`);
    lines.push(`  Categor  (${s.categorical_columns}): ${s.categorical_column_names.join(', ') || 'none'}`);
    if (s.generator_used) {
        lines.push(`  Generator: ${s.generator_used} | Synthetic rows: ${s.synthetic_rows}`);
    }
    lines.push('');
    // Risk metrics
    lines.push('### Risk Metrics');
    lines.push(`  Dataset Risk Score:       ${r.dataset_risk_score != null ? r.dataset_risk_score.toFixed(1) + '/100' : 'N/A'}`);
    lines.push(`  Intelligence Risk:        ${r.dataset_intelligence_risk != null ? r.dataset_intelligence_risk.toFixed(1) + '/100 [' + r.intelligence_risk_label + ']' : 'N/A'}`);
    lines.push(`  Privacy Score:            ${r.privacy_score_pct ?? 'N/A'} (higher = more private)`);
    lines.push(`  MI-AUC:                   ${r.membership_inference_auc ?? 'N/A'} (>0.5 = attacker advantage)`);
    lines.push(`  Duplicates Rate:          ${r.duplicates_rate != null ? (r.duplicates_rate * 100).toFixed(2) + '%' : 'N/A'}`);
    lines.push(`  Avg Drift Score:          ${r.avg_drift_score != null ? r.avg_drift_score.toFixed(4) : 'N/A'}`);
    lines.push(`  Risk Level:               ${r.risk_level ?? 'N/A'}`);
    lines.push('');
    // Privacy components
    if (ctx.privacy_components) {
        const pc = ctx.privacy_components;
        lines.push('### Privacy Risk Breakdown (0=safe, 1=critical)');
        lines.push(`  Duplicates Risk:           ${pc.duplicates_risk.toFixed(3)}`);
        lines.push(`  MI Attack Risk:            ${pc.mi_attack_risk.toFixed(3)}`);
        lines.push(`  Distance Similarity Risk:  ${pc.distance_similarity_risk.toFixed(3)}`);
        lines.push(`  Distribution Drift Risk:   ${pc.distribution_drift_risk.toFixed(3)}`);
        lines.push('');
    }
    // PII columns
    if (ctx.pii_columns.length > 0) {
        lines.push(`### PII Columns (${ctx.pii_columns.length})`);
        lines.push(`  ${ctx.pii_columns.join(', ')}`);
        lines.push('');
    }
    // Sensitive column ranking
    if (ctx.sensitive_columns.length > 0) {
        lines.push('### Sensitive Column Ranking (composite score)');
        ctx.sensitive_columns.slice(0, 8).forEach((sc, i) => {
            lines.push(`  ${i + 1}. ${sc.column}: score=${sc.score.toFixed(3)}` +
                ` PII=${(sc.pii_score * 100).toFixed(0)}%` +
                ` ReID=${(sc.reidentification_risk * 100).toFixed(0)}%` +
                ` Drift=${(sc.drift_score * 100).toFixed(0)}%`);
        });
        lines.push('');
    }
    // Column drift top-10
    const driftEntries = Object.entries(ctx.column_drift).sort(([, a], [, b]) => b - a).slice(0, 10);
    if (driftEntries.length > 0) {
        lines.push('### Column Drift (JS-divergence, top 10)');
        for (const [col, d] of driftEntries) {
            const lbl = d > 0.15 ? 'HIGH' : d > 0.05 ? 'MODERATE' : 'LOW';
            lines.push(`  ${col}: ${d.toFixed(4)} [${lbl}]`);
        }
        lines.push('');
    }
    // Anomalies
    if (ctx.anomalies.length > 0) {
        lines.push(`### Detected Anomalies (${ctx.anomalies.length})`);
        ctx.anomalies.slice(0, 8).forEach(a => {
            lines.push(`  [${a.severity.toUpperCase()}] ${a.column} — ${a.issue}: ${a.detail}`);
        });
        lines.push('');
    }
    // Governance actions
    if (ctx.governance_actions.length > 0) {
        lines.push('### Required Governance Actions');
        ctx.governance_actions.slice(0, 6).forEach(ga => {
            lines.push(`  [${ga.urgency.toUpperCase()}] ${ga.column}: ${ga.action} — ${ga.reason}`);
        });
        lines.push('');
    }
    // Threats
    if (ctx.threats.length > 0) {
        lines.push('### Active Privacy Threats');
        ctx.threats.slice(0, 5).forEach(t => {
            lines.push(`  ${t.name} [${t.severity}, conf=${(t.confidence * 100).toFixed(0)}%]: ${t.description}`);
            if (t.triggered_by.length > 0) {
                lines.push(`    Triggered by: ${t.triggered_by.join(', ')}`);
            }
        });
        lines.push('');
    }
    // SQL schema
    const schema = exports.AgentTools.get_sql_schema(ctx);
    if (schema.columns.length > 0) {
        lines.push(`### SQL Schema (table: ${schema.table})`);
        lines.push('  Columns: ' + schema.columns.map(c => `${c.name} ${c.type}${c.is_pii ? '*PII*' : ''}`).join(', '));
        lines.push('');
    }
    // Reasoning rules
    lines.push('### Agent Reasoning Rules');
    lines.push('  R1: Cite EXACT column names and metric values from this context in every answer.');
    lines.push('  R2: Never fabricate statistics. If a value is missing, say "metric unavailable".');
    lines.push('  R3: For SQL generation, use only column names present in the SQL Schema above.');
    lines.push('  R4: For anomaly questions, cite IQR/drift/null_ratio values from the context.');
    lines.push('  R5: For governance recommendations, base urgency on re-identification risk and PII score.');
    lines.push('  R6: For cleaning suggestions, reference actual null_ratio and outlier details.');
    lines.push('');
    return lines.join('\n');
}
/**
 * Build the canonical StructuredDatasetContext used by the governance-analyst
 * prompt (Phase 1).  Every field is sourced directly from pipeline results;
 * no defaults or estimates are injected.
 */
function buildStructuredDatasetContext(ctx) {
    const s = ctx.dataset_summary;
    const r = ctx.risk_metrics;
    // All known column names — the authoritative list (Phase 4 validator uses this)
    const allColumns = [
        ...s.numeric_column_names,
        ...s.categorical_column_names,
    ];
    // Build sensitive column list with re-id scores
    const sensitiveColList = ctx.sensitive_columns.map(sc => ({
        name: sc.column,
        reid_score: sc.reidentification_risk,
        is_pii: ctx.pii_columns.includes(sc.column),
    }));
    // Format recent alerts as short strings
    const alertStrings = ctx.recent_alerts.slice(0, 10).map(a => `[${a.severity.toUpperCase()}] ${a.type} — ${a.pattern} (file: ${a.file})`);
    return {
        rows: s.rows,
        columns: allColumns,
        privacy_score: r.privacy_score,
        dataset_risk_score: r.dataset_risk_score,
        statistical_reliability_score: r.statistical_reliability_score,
        sensitive_columns: sensitiveColList,
        column_drift: ctx.column_drift,
        pii_columns: ctx.pii_columns,
        recent_security_alerts: alertStrings,
    };
}
/**
 * Serialise the StructuredDatasetContext into the canonical DATASET_CONTEXT
 * text block injected into the governance-analyst system prompt (Phase 1).
 */
function formatStructuredDatasetContext(sdc) {
    const lines = [];
    lines.push('DATASET_CONTEXT');
    lines.push('---------------');
    lines.push(`rows: ${sdc.rows ?? 'unavailable'}`);
    lines.push(`columns: ${sdc.columns.length > 0 ? sdc.columns.join(', ') : 'none'}`);
    lines.push('');
    lines.push(`privacy_score: ${sdc.privacy_score != null ? sdc.privacy_score.toFixed(4) : 'unavailable'}`);
    lines.push(`dataset_risk_score: ${sdc.dataset_risk_score != null ? sdc.dataset_risk_score.toFixed(2) : 'unavailable'}`);
    lines.push(`statistical_reliability_score: ${sdc.statistical_reliability_score != null ? sdc.statistical_reliability_score.toFixed(4) : 'unavailable'}`);
    lines.push('');
    if (sdc.sensitive_columns.length > 0) {
        lines.push('sensitive_columns:');
        for (const sc of sdc.sensitive_columns) {
            lines.push(` - ${sc.name}`);
        }
        lines.push('');
    }
    else {
        lines.push('sensitive_columns: none');
        lines.push('');
    }
    const driftEntries = Object.entries(sdc.column_drift).sort(([, a], [, b]) => b - a);
    if (driftEntries.length > 0) {
        lines.push('column_drift:');
        for (const [col, score] of driftEntries) {
            lines.push(`  ${col}: ${score.toFixed(4)}`);
        }
        lines.push('');
    }
    else {
        lines.push('column_drift: none');
        lines.push('');
    }
    if (sdc.pii_columns.length > 0) {
        lines.push(`pii_columns: ${sdc.pii_columns.join(', ')}`);
    }
    else {
        lines.push('pii_columns: none');
    }
    lines.push('');
    if (sdc.recent_security_alerts.length > 0) {
        lines.push('recent_security_alerts:');
        for (const alert of sdc.recent_security_alerts) {
            lines.push(`  ${alert}`);
        }
    }
    else {
        lines.push('recent_security_alerts: none');
    }
    lines.push('');
    return lines.join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Valid metric number extractor
// Returns every numeric value present in the pipeline context so the
// response validator can check for fabricated numbers.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Return the complete set of numeric values that legitimately appear in the
 * pipeline dataset context.  The LLM response validator uses this to flag
 * numbers that were not sourced from real pipeline measurements.
 */
function getValidNumbers(sdc) {
    const valid = new Set();
    const addNum = (n) => {
        if (n == null) {
            return;
        }
        // Allow the raw value as well as common rounded representations
        valid.add(n.toString());
        valid.add(n.toFixed(0));
        valid.add(n.toFixed(1));
        valid.add(n.toFixed(2));
        valid.add(n.toFixed(3));
        valid.add(n.toFixed(4));
        // Percentage form
        valid.add((n * 100).toFixed(0));
        valid.add((n * 100).toFixed(1));
        valid.add((n * 100).toFixed(2));
    };
    addNum(sdc.rows);
    addNum(sdc.privacy_score);
    addNum(sdc.dataset_risk_score);
    addNum(sdc.statistical_reliability_score);
    addNum(sdc.columns.length);
    for (const sc of sdc.sensitive_columns) {
        addNum(sc.reid_score);
    }
    for (const score of Object.values(sdc.column_drift)) {
        addNum(score);
    }
    return valid;
}
//# sourceMappingURL=dataset_context_builder.js.map