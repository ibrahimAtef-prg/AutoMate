/**
 * ai_agent_tests.ts — Phase 5: AI Data Governance Agent Validation Tests
 *
 * Tests the DatasetContext builder, AgentTools, formatContextForLLM,
 * anomaly detection, cleaning suggestions, governance actions, and
 * SQL schema extraction — all WITHOUT a VS Code process or LLM call.
 *
 * Every assertion verifies that outputs are grounded in real metrics,
 * not fabricated values.
 *
 * Run: npx ts-node src/test/ai_agent_tests.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline re-implementations (mirror production code, no VS Code dependency)
// ─────────────────────────────────────────────────────────────────────────────

/* ---------- Types (mirror dataset_context_builder.ts) --------------------- */

interface DatasetSummary {
    rows: number | null; columns: number;
    numeric_columns: number; categorical_columns: number;
    numeric_column_names: string[]; categorical_column_names: string[];
    source_file: string | null; generator_used: string | null; synthetic_rows: number | null;
}
interface RiskMetrics {
    dataset_risk_score: number | null; dataset_intelligence_risk: number | null;
    intelligence_risk_label: string | null; privacy_score: number | null;
    privacy_score_pct: string | null; membership_inference_auc: number | null;
    duplicates_rate: number | null; statistical_drift: string | null;
    avg_drift_score: number | null; risk_level: string | null;
    statistical_reliability_score: number | null;
}
interface SensitiveColumn { column: string; score: number; pii_score: number; reidentification_risk: number; drift_score: number; }
interface AnomalySignal { column: string; issue: string; severity: string; detail: string; }
interface CleaningSuggestion { column: string; issue: string; action: string; priority: string; }
interface GovernanceAction { column: string; action: string; reason: string; urgency: string; }
interface ColumnStats { name: string; type: string; min?: number; max?: number; mean?: number; std?: number; null_ratio?: number; unique_ratio?: number; is_pii?: boolean; drift_score?: number; reidentification_risk?: number; }
interface DatasetContext {
    dataset_summary: DatasetSummary; risk_metrics: RiskMetrics;
    privacy_components: any; pii_columns: string[];
    sensitive_columns: SensitiveColumn[]; column_stats: ColumnStats[];
    column_drift: Record<string, number>; anomalies: AnomalySignal[];
    cleaning_suggestions: CleaningSuggestion[]; governance_actions: GovernanceAction[];
    threats: any[]; top_correlations: any[]; recent_alerts: any[];
    has_data: boolean; built_at: string;
}

/* ---------- Production builder (inline) ------------------------------------ */

function buildDatasetContext(ctx: any): DatasetContext {
    const b  = ctx.baseline   ?? {};
    const l  = ctx.leakage    ?? {};
    const r  = ctx.result     ?? {};
    const sc = ctx.scanReport ?? {};
    const g  = ctx.graph      ?? {};

    const numCols  = Object.keys(b.columns?.numeric      ?? {});
    const catCols  = Object.keys(b.columns?.categorical   ?? {});
    const allCols  = [...numCols, ...catCols];
    const meta     = b.meta ?? {};
    const profile  = (ctx.ast?.dataset ?? ctx.ast ?? {}).profile ?? {};

    const summary: DatasetSummary = {
        rows: meta.row_count ?? profile.row_count_estimate ?? null,
        columns: (allCols.length || meta.column_count) ?? 0,
        numeric_columns: numCols.length, categorical_columns: catCols.length,
        numeric_column_names: numCols, categorical_column_names: catCols,
        source_file: meta.dataset_source ?? null,
        generator_used: r.generator_used ?? null, synthetic_rows: r.row_count ?? null,
    };

    const dir = l.dataset_intelligence_risk ?? {};
    const ps  = l.privacy_score;
    const risk: RiskMetrics = {
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

    const pc = l.privacy_components ? {
        duplicates_risk: l.privacy_components.duplicates_risk ?? 0,
        mi_attack_risk: l.privacy_components.mi_attack_risk ?? 0,
        distance_similarity_risk: l.privacy_components.distance_similarity_risk ?? 0,
        distribution_drift_risk: l.privacy_components.distribution_drift_risk ?? 0,
    } : null;

    const piiCols: string[] = [...new Set([
        ...(sc.high_risk_columns ?? []),
        ...((sc.pii_findings ?? []).map((f: any) => f.column).filter(Boolean)),
    ])] as string[];

    const sensitiveColumns: SensitiveColumn[] = (l.sensitive_column_ranking ?? []).slice(0, 12).map((item: any) => ({
        column: item.column, score: item.score ?? 0,
        pii_score: item.signals?.pii_score ?? 0,
        reidentification_risk: item.signals?.reidentification_risk ?? 0,
        drift_score: item.signals?.drift_score ?? 0,
    }));

    const reidRisk: Record<string, number> = l.reidentification_risk ?? {};
    const colDrift: Record<string, number> = l.column_drift ?? {};

    const columnStats: ColumnStats[] = [];
    for (const [col, stats] of Object.entries(b.columns?.numeric ?? {})) {
        const s = stats as any;
        columnStats.push({ name: col, type: 'numeric', min: s.min, max: s.max, mean: s.mean, std: s.std, null_ratio: s.null_ratio, drift_score: colDrift[col], reidentification_risk: reidRisk[col], is_pii: piiCols.includes(col) });
    }
    for (const [col, stats] of Object.entries(b.columns?.categorical ?? {})) {
        const s = stats as any;
        columnStats.push({ name: col, type: 'categorical', null_ratio: s.null_ratio, unique_ratio: s.unique_ratio, drift_score: colDrift[col], reidentification_risk: reidRisk[col], is_pii: piiCols.includes(col) });
    }

    // Anomalies
    const anomalies: AnomalySignal[] = [];
    for (const [col, drift] of Object.entries(colDrift).sort(([, a], [, b]) => (b as number) - (a as number)).slice(0, 8)) {
        if ((drift as number) > 0.15) {
            anomalies.push({ column: col, issue: 'Distribution drift', severity: (drift as number) > 0.30 ? 'high' : 'medium', detail: `JS-divergence=${(drift as number).toFixed(4)} — synthetic distribution diverges significantly from original` });
        }
    }
    for (const cs of columnStats) {
        if ((cs.null_ratio ?? 0) > 0.30) {
            anomalies.push({ column: cs.name, issue: 'High missing rate', severity: (cs.null_ratio ?? 0) > 0.60 ? 'high' : 'medium', detail: `null_ratio=${((cs.null_ratio ?? 0) * 100).toFixed(1)}% — column has excessive missing values` });
        }
        if (cs.type === 'numeric' && cs.mean != null && cs.std != null && Math.abs(cs.mean) > 0) {
            const cv = Math.abs(cs.std / cs.mean);
            if (cv > 3.0) { anomalies.push({ column: cs.name, issue: 'High variance / skewed distribution', severity: 'medium', detail: `CV=${cv.toFixed(2)} (std/mean)` }); }
        }
    }
    for (const ot of (l.outlier_risk ?? []).slice(0, 5)) {
        anomalies.push({ column: ot.column, issue: 'Outlier exposure risk', severity: ['critical','high'].includes(ot.severity) ? 'high' : 'medium', detail: `value=${ot.value}, ${ot.extreme_ratio}× IQR fence` });
    }

    // Cleaning suggestions
    const cleaningSuggestions: CleaningSuggestion[] = [];
    for (const cs of columnStats) {
        const nr = cs.null_ratio ?? 0;
        if (nr > 0.60) { cleaningSuggestions.push({ column: cs.name, issue: `${(nr*100).toFixed(0)}% missing`, action: 'Consider dropping this column — missing rate is too high', priority: 'high' }); }
        else if (nr > 0.30) { cleaningSuggestions.push({ column: cs.name, issue: `${(nr*100).toFixed(0)}% missing`, action: cs.type === 'numeric' ? 'Impute with median or model-based imputation' : 'Impute with mode or "Unknown" category', priority: 'medium' }); }
    }
    for (const an of anomalies) {
        if (an.issue === 'High variance / skewed distribution') { cleaningSuggestions.push({ column: an.column, issue: 'Extreme skew / outliers', action: 'Apply log1p transform or IQR-based clipping', priority: 'medium' }); }
        if (an.issue === 'Outlier exposure risk') { cleaningSuggestions.push({ column: an.column, issue: 'Individual outlier exposure', action: 'Clip to 99th percentile or add Laplace noise', priority: 'high' }); }
    }
    for (const col of piiCols) {
        const scEntry = sensitiveColumns.find(s => s.column === col);
        if (scEntry && scEntry.reidentification_risk > 0.6) { cleaningSuggestions.push({ column: col, issue: `Re-ID risk ${(scEntry.reidentification_risk*100).toFixed(0)}%`, action: 'Apply k-anonymity or hashed surrogate', priority: 'high' }); }
        else { cleaningSuggestions.push({ column: col, issue: 'PII detected', action: 'Mask with format-preserving pseudonymisation or remove', priority: 'medium' }); }
    }

    // Governance actions
    const govActions: GovernanceAction[] = [];
    for (const sc2 of sensitiveColumns.slice(0, 6)) {
        if (sc2.pii_score > 0.7) { govActions.push({ column: sc2.column, action: 'Mask or tokenise', reason: `PII score ${(sc2.pii_score*100).toFixed(0)}%`, urgency: 'high' }); }
        if (sc2.reidentification_risk > 0.7) { govActions.push({ column: sc2.column, action: 'Apply k-anonymity or suppress', reason: `Re-ID risk ${(sc2.reidentification_risk*100).toFixed(0)}%`, urgency: 'critical' }); }
    }
    if (dir.score != null && dir.score >= 70) { govActions.push({ column: 'DATASET', action: 'Mandatory privacy impact assessment', reason: `Intelligence risk ${dir.score.toFixed(0)}/100`, urgency: 'critical' }); }
    const govActionsUnique = govActions.filter((a, i, arr) => i === arr.findIndex(b2 => b2.column === a.column && b2.action === a.action));

    const threats = (l.threat_details ?? l.top_threats ?? []).map((t: any) => ({ name: t.name, severity: t.severity, confidence: t.confidence ?? 0, description: t.description ?? '', triggered_by: t.triggered_by ?? [] }));
    const topCorr = (g.top_correlations ?? []).slice(0, 8).map((c: any) => ({ cols: c.cols, pearson: c.pearson, strength: c.strength }));

    return {
        dataset_summary: summary, risk_metrics: risk, privacy_components: pc,
        pii_columns: piiCols, sensitive_columns: sensitiveColumns,
        column_stats: columnStats, column_drift: colDrift, anomalies,
        cleaning_suggestions: cleaningSuggestions, governance_actions: govActionsUnique,
        threats, top_correlations: topCorr, recent_alerts: [],
        has_data: allCols.length > 0 || Object.keys(colDrift).length > 0,
        built_at: new Date().toISOString(),
    };
}

function formatContextForLLM(ctx: DatasetContext): string {
    const lines: string[] = [];
    const s = ctx.dataset_summary; const r = ctx.risk_metrics;
    lines.push('## DATASET ANALYSIS CONTEXT');
    lines.push('(All values are real pipeline measurements — do NOT invent numbers not present here.)');
    lines.push('');
    lines.push('### Dataset Summary');
    lines.push(`  Rows: ${s.rows ?? 'unknown'} | Columns: ${s.columns}`);
    lines.push(`  Numeric  (${s.numeric_columns}): ${s.numeric_column_names.join(', ') || 'none'}`);
    lines.push(`  Categor  (${s.categorical_columns}): ${s.categorical_column_names.join(', ') || 'none'}`);
    lines.push('');
    lines.push('### Risk Metrics');
    lines.push(`  Dataset Risk Score: ${r.dataset_risk_score != null ? r.dataset_risk_score.toFixed(1)+'/100' : 'N/A'}`);
    lines.push(`  Privacy Score: ${r.privacy_score_pct ?? 'N/A'}`);
    lines.push(`  MI-AUC: ${r.membership_inference_auc ?? 'N/A'}`);
    lines.push('');
    if (ctx.pii_columns.length > 0) { lines.push(`### PII Columns`); lines.push(`  ${ctx.pii_columns.join(', ')}`); lines.push(''); }
    if (ctx.sensitive_columns.length > 0) {
        lines.push('### Sensitive Column Ranking');
        ctx.sensitive_columns.slice(0, 6).forEach((sc, i) => { lines.push(`  ${i+1}. ${sc.column}: score=${sc.score.toFixed(3)} PII=${(sc.pii_score*100).toFixed(0)}% ReID=${(sc.reidentification_risk*100).toFixed(0)}%`); });
        lines.push('');
    }
    if (ctx.anomalies.length > 0) {
        lines.push(`### Detected Anomalies (${ctx.anomalies.length})`);
        ctx.anomalies.slice(0, 6).forEach(a => { lines.push(`  [${a.severity.toUpperCase()}] ${a.column} — ${a.issue}: ${a.detail}`); });
        lines.push('');
    }
    lines.push('### Agent Reasoning Rules');
    lines.push('  R1: Cite EXACT column names and metric values from this context in every answer.');
    lines.push('  R2: Never fabricate statistics. If a value is missing, say "metric unavailable".');
    lines.push('  R3: For SQL generation, use only column names present in the SQL Schema above.');
    lines.push('');
    return lines.join('\n');
}

const AgentTools = {
    get_dataset_summary(ctx: DatasetContext) { return ctx.dataset_summary; },
    get_sensitive_columns(ctx: DatasetContext) { return ctx.sensitive_columns; },
    get_privacy_metrics(ctx: DatasetContext) { return { risk_metrics: ctx.risk_metrics, privacy_components: ctx.privacy_components, threats: ctx.threats }; },
    get_pii_findings(ctx: DatasetContext) { return { pii_columns: ctx.pii_columns, cleaning_suggestions: ctx.cleaning_suggestions.filter(s => ctx.pii_columns.includes(s.column)), governance_actions: ctx.governance_actions }; },
    get_recent_alerts(ctx: DatasetContext) { return ctx.recent_alerts; },
    get_anomalies(ctx: DatasetContext) { return ctx.anomalies; },
    get_column_stats(ctx: DatasetContext, col?: string) { return col ? ctx.column_stats.filter(c => c.name === col) : ctx.column_stats; },
    get_sql_schema(ctx: DatasetContext) {
        return {
            table: ctx.dataset_summary.source_file?.replace(/[^a-zA-Z0-9_]/g, '_') ?? 'dataset',
            columns: ctx.column_stats.map(c => ({ name: c.name, type: c.type === 'numeric' ? 'NUMERIC' : 'VARCHAR', nullable: (c.null_ratio ?? 0) > 0, is_pii: c.is_pii ?? false })),
        };
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture data — realistic pipeline outputs
// ─────────────────────────────────────────────────────────────────────────────

const RICH_PIPELINE: any = {
    baseline: {
        meta: { row_count: 1200, column_count: 8, dataset_source: 'customers.csv' },
        columns: {
            numeric: {
                age:    { min: 18, max: 85, mean: 42.3, std: 14.1, null_ratio: 0.02 },
                income: { min: 0, max: 500000, mean: 55000, std: 120000, null_ratio: 0.12 },
                score:  { min: 0, max: 1, mean: 0.6, std: 0.22, null_ratio: 0.0 },
                visits: { min: 0, max: 900, mean: 12, std: 95, null_ratio: 0.45 },
            },
            categorical: {
                email:    { null_ratio: 0.0,  unique_ratio: 0.98 },
                zipcode:  { null_ratio: 0.03, unique_ratio: 0.65 },
                gender:   { null_ratio: 0.01, unique_ratio: 0.02 },
                country:  { null_ratio: 0.0,  unique_ratio: 0.08 },
            },
        },
    },
    leakage: {
        risk_level: 'HIGH',
        privacy_score: 0.73,
        dataset_risk_score: 62.4,
        membership_inference_auc: 0.74,
        duplicates_rate: 0.018,
        statistical_drift: 'MODERATE',
        avg_drift_score: 0.112,
        dataset_intelligence_risk: { score: 71.5, label: 'HIGH' },
        privacy_components: { duplicates_risk: 0.018, mi_attack_risk: 0.48, distance_similarity_risk: 0.12, distribution_drift_risk: 0.31 },
        column_drift: { income: 0.34, visits: 0.22, age: 0.08, score: 0.04, email: 0.01 },
        reidentification_risk: { email: 0.95, zipcode: 0.72, age: 0.31, income: 0.44 },
        sensitive_column_ranking: [
            { column: 'email',   score: 0.94, signals: { pii_score: 0.95, reidentification_risk: 0.95, drift_score: 0.01 } },
            { column: 'zipcode', score: 0.71, signals: { pii_score: 0.60, reidentification_risk: 0.72, drift_score: 0.05 } },
            { column: 'income',  score: 0.58, signals: { pii_score: 0.20, reidentification_risk: 0.44, drift_score: 0.34 } },
            { column: 'age',     score: 0.32, signals: { pii_score: 0.10, reidentification_risk: 0.31, drift_score: 0.08 } },
        ],
        outlier_risk: [
            { column: 'income', severity: 'high', value: 498000, extreme_ratio: 4.2 },
        ],
        threat_details: [
            { name: 'Membership Inference', severity: 'HIGH', confidence: 0.74, description: 'AUC above 0.5 indicates attacker advantage', triggered_by: ['income', 'age'] },
            { name: 'Re-identification via email', severity: 'CRITICAL', confidence: 0.95, description: 'Email column directly identifies individuals', triggered_by: ['email'] },
        ],
        statistical_reliability_score: 0.82,
    },
    scanReport: {
        high_risk_columns: ['email'],
        pii_findings: [
            { column: 'email', type: 'Email', category: 'pii', severity: 'high' },
            { column: 'zipcode', type: 'Location', category: 'pii', severity: 'medium' },
        ],
        risk_score: 68,
    },
    result: { row_count: 500, generator_used: 'CTGAN' },
    graph: {
        top_correlations: [
            { cols: 'income↔score', pearson: 0.61, strength: 'strong' },
            { cols: 'age↔visits',   pearson: -0.29, strength: 'moderate' },
        ],
    },
};

const EMPTY_PIPELINE: any = {};

const MINIMAL_PIPELINE: any = {
    baseline: {
        meta: { row_count: 100 },
        columns: {
            numeric: { price: { min: 0, max: 1000, mean: 200, std: 80, null_ratio: 0.0 } },
            categorical: { category: { null_ratio: 0.0, unique_ratio: 0.05 } },
        },
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let _pass = 0; let _fail = 0;
const _failedTests: string[] = [];

function t(name: string, fn: () => void): void {
    try { fn(); _pass++; process.stdout.write(`  ✅  ${name}\n`); }
    catch(e: any) { _fail++; _failedTests.push(name); process.stdout.write(`  ❌  ${name}\n     └─ ${e.message}\n`); }
}
function suite(label: string): void { process.stdout.write(`\n▶ ${label}\n`); }

function eq(a: any, b: any, msg?: string): void { if (a !== b) { throw new Error(msg ?? `Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); } }
function ok(cond: any, msg?: string): void { if (!cond) { throw new Error(msg ?? 'Assertion failed'); } }
function gt(a: number, b: number, msg?: string): void { if (!(a > b)) { throw new Error(msg ?? `Expected ${a} > ${b}`); } }
function gte(a: number, b: number, msg?: string): void { if (!(a >= b)) { throw new Error(msg ?? `Expected ${a} >= ${b}`); } }
function contains(s: string, sub: string, msg?: string): void { if (!s.includes(sub)) { throw new Error(msg ?? `Expected "${s.substring(0,80)}" to contain "${sub}"`); } }
function notNull(v: any, msg?: string): void { if (v == null) { throw new Error(msg ?? 'Expected non-null'); } }

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — DatasetContext Builder: Summary
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 1 — DatasetContext Builder: Summary');

t('Correct row count from baseline.meta', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.dataset_summary.rows, 1200);
});
t('Correct column count (numeric + categorical)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.dataset_summary.columns, 8);
    eq(ctx.dataset_summary.numeric_columns, 4);
    eq(ctx.dataset_summary.categorical_columns, 4);
});
t('Numeric column names are extracted correctly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(ctx.dataset_summary.numeric_column_names.includes('age'), 'age missing');
    ok(ctx.dataset_summary.numeric_column_names.includes('income'), 'income missing');
});
t('Categorical column names are extracted correctly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(ctx.dataset_summary.categorical_column_names.includes('email'), 'email missing');
    ok(ctx.dataset_summary.categorical_column_names.includes('zipcode'), 'zipcode missing');
});
t('Source file is read from baseline.meta.dataset_source', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.dataset_summary.source_file, 'customers.csv');
});
t('Generator info from result', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.dataset_summary.generator_used, 'CTGAN');
    eq(ctx.dataset_summary.synthetic_rows, 500);
});
t('Empty pipeline produces has_data=false', () => {
    const ctx = buildDatasetContext(EMPTY_PIPELINE);
    eq(ctx.has_data, false);
});
t('Minimal pipeline produces has_data=true', () => {
    const ctx = buildDatasetContext(MINIMAL_PIPELINE);
    eq(ctx.has_data, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Risk Metrics
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 2 — Risk Metrics');

t('Dataset risk score from leakage', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(Math.abs((ctx.risk_metrics.dataset_risk_score ?? 0) - 62.4) < 0.01, 'Wrong risk score');
});
t('Privacy score percentage string formatted correctly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.risk_metrics.privacy_score_pct, '73.0%');
});
t('MI-AUC is preserved exactly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    eq(ctx.risk_metrics.membership_inference_auc, 0.74);
});
t('Intelligence risk score and label extracted', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(Math.abs((ctx.risk_metrics.dataset_intelligence_risk ?? 0) - 71.5) < 0.01);
    eq(ctx.risk_metrics.intelligence_risk_label, 'HIGH');
});
t('Privacy components extracted correctly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    notNull(ctx.privacy_components, 'Privacy components null');
    ok(Math.abs(ctx.privacy_components!.mi_attack_risk - 0.48) < 0.001);
    ok(Math.abs(ctx.privacy_components!.distribution_drift_risk - 0.31) < 0.001);
});
t('Empty pipeline returns null risk scores', () => {
    const ctx = buildDatasetContext(EMPTY_PIPELINE);
    eq(ctx.risk_metrics.dataset_risk_score, null);
    eq(ctx.risk_metrics.privacy_score_pct, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — PII & Sensitive Columns
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 3 — PII & Sensitive Columns');

t('PII columns populated from scanReport.high_risk_columns', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(ctx.pii_columns.includes('email'), 'email should be PII');
});
t('PII columns deduplicated (no duplicates)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const unique = new Set(ctx.pii_columns);
    eq(ctx.pii_columns.length, unique.size, 'Duplicate PII columns found');
});
t('Sensitive column ranking ordered by score descending', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const scores = ctx.sensitive_columns.map(s => s.score);
    for (let i = 1; i < scores.length; i++) {
        ok(scores[i - 1] >= scores[i], `Not descending at index ${i}`);
    }
});
t('email has highest PII score (0.95)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const emailCol = ctx.sensitive_columns.find(s => s.column === 'email');
    notNull(emailCol, 'email not in sensitive columns');
    ok(Math.abs(emailCol!.pii_score - 0.95) < 0.001);
});
t('email has highest re-identification risk', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const emailCol = ctx.sensitive_columns.find(s => s.column === 'email');
    ok((emailCol?.reidentification_risk ?? 0) >= 0.9);
});
t('Column is_pii flagged when in PII list', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const emailStat = ctx.column_stats.find(c => c.name === 'email');
    ok(emailStat?.is_pii === true, 'email should be flagged is_pii');
});
t('Non-PII column is not flagged is_pii', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ageStat = ctx.column_stats.find(c => c.name === 'age');
    ok(ageStat?.is_pii !== true, 'age should not be PII');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Anomaly Detection (Part 3)
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 4 — Anomaly Detection');

t('High drift column (income, drift=0.34) detected as anomaly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'income' && a.issue === 'Distribution drift');
    notNull(anom, 'income drift anomaly missing');
    eq(anom!.severity, 'high', 'Should be high (>0.30)');
});
t('Moderate drift column (visits, drift=0.22) detected as medium severity', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'visits' && a.issue === 'Distribution drift');
    notNull(anom, 'visits drift anomaly missing');
    eq(anom!.severity, 'medium');
});
t('Low drift columns not flagged as anomalies', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ageAnom = ctx.anomalies.find(a => a.column === 'age' && a.issue === 'Distribution drift');
    eq(ageAnom, undefined, 'age (drift=0.08) should not be flagged');
});
t('High missing rate column (visits, 45%) detected as anomaly', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'visits' && a.issue === 'High missing rate');
    notNull(anom, 'visits high missing rate anomaly not detected');
});
t('Low missing rate column (income, 12%) not flagged', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'income' && a.issue === 'High missing rate');
    eq(anom, undefined, 'income (12% null) should not be flagged as high missing');
});
t('High CV column detected (visits: CV = 95/12 ≈ 7.9)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'visits' && a.issue === 'High variance / skewed distribution');
    notNull(anom, 'High CV anomaly for visits not detected');
    contains(anom!.detail, 'CV=', 'Detail should contain CV value');
});
t('Outlier risk from leakage.outlier_risk detected', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anom = ctx.anomalies.find(a => a.column === 'income' && a.issue === 'Outlier exposure risk');
    notNull(anom, 'income outlier risk not detected');
    contains(anom!.detail, '4.2', 'Detail should contain IQR multiplier');
});
t('Anomaly detail contains real drift value', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const incomeAnom = ctx.anomalies.find(a => a.column === 'income' && a.issue === 'Distribution drift');
    notNull(incomeAnom);
    contains(incomeAnom!.detail, '0.3400', 'Should cite exact drift score');
});
t('No anomalies on empty pipeline', () => {
    const ctx = buildDatasetContext(EMPTY_PIPELINE);
    eq(ctx.anomalies.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 — Cleaning Suggestions (Part 4)
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 5 — Cleaning Suggestions');

t('Column with 45% missing gets imputation suggestion', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const sug = ctx.cleaning_suggestions.find(s => s.column === 'visits' && s.action.includes('mputation'));
    notNull(sug, 'visits imputation suggestion missing');
    eq(sug!.priority, 'medium');
});
t('PII column (email) gets masking suggestion', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const sug = ctx.cleaning_suggestions.find(s => s.column === 'email');
    notNull(sug, 'email cleaning suggestion missing');
    ok(sug!.action.toLowerCase().includes('mask') || sug!.action.toLowerCase().includes('anon') || sug!.action.toLowerCase().includes('k-anon'), 'Expected masking action');
});
t('High-CV column gets log/clip suggestion', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const sug = ctx.cleaning_suggestions.find(s => s.column === 'visits' && (s.action.includes('log') || s.action.includes('clip')));
    notNull(sug, 'visits skew suggestion missing');
});
t('Outlier column gets clipping suggestion', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const sug = ctx.cleaning_suggestions.find(s => s.column === 'income' && s.issue.toLowerCase().includes('outlier'));
    notNull(sug, 'income outlier suggestion missing');
    ok(sug!.action.includes('lip') || sug!.action.includes('noise'), 'Expected clip or noise action');
});
t('Suggestions have valid priority values', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const valid = new Set(['low', 'medium', 'high']);
    ctx.cleaning_suggestions.forEach(s => {
        ok(valid.has(s.priority), `Invalid priority: ${s.priority}`);
    });
});
t('Column with zero missing rate gets no imputation suggestion', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ageSugs = ctx.cleaning_suggestions.filter(s => s.column === 'age' && s.action.includes('mputation'));
    eq(ageSugs.length, 0, 'age has very low null_ratio, should not need imputation');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6 — Governance Actions (Part 7)
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 6 — Governance Actions');

t('email gets governance action due to high PII score', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ga = ctx.governance_actions.find(a => a.column === 'email');
    notNull(ga, 'No governance action for email');
    ok(['high','critical'].includes(ga!.urgency), 'email urgency should be high or critical');
});
t('email gets k-anonymity or masking action', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const gas = ctx.governance_actions.filter(a => a.column === 'email');
    ok(gas.some(a => a.action.toLowerCase().includes('mask') || a.action.toLowerCase().includes('anon') || a.action.toLowerCase().includes('k-anon') || a.action.toLowerCase().includes('tokenis')), 'Expected masking/anonymisation action for email');
});
t('High intelligence risk score triggers dataset-level action', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ga = ctx.governance_actions.find(a => a.column === 'DATASET');
    notNull(ga, 'No dataset-level governance action');
    eq(ga!.urgency, 'critical');
    ok(ga!.reason.includes('71') || ga!.reason.includes('72'), 'Reason should cite intelligence risk score, got: '+ga!.reason);
});
t('Governance actions have valid urgency levels', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const valid = new Set(['low', 'medium', 'high', 'critical']);
    ctx.governance_actions.forEach(a => { ok(valid.has(a.urgency), `Invalid urgency: ${a.urgency}`); });
});
t('No duplicate governance actions (same column + action)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const seen = new Set<string>();
    ctx.governance_actions.forEach(a => {
        const key = `${a.column}::${a.action}`;
        ok(!seen.has(key), `Duplicate governance action: ${key}`);
        seen.add(key);
    });
});
t('zipcode gets action due to high re-identification risk (0.72)', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const ga = ctx.governance_actions.find(a => a.column === 'zipcode');
    notNull(ga, 'No governance action for zipcode');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 7 — Agent Tools (Part 9)
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 7 — Agent Tools');

t('get_dataset_summary returns correct summary', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const s = AgentTools.get_dataset_summary(ctx);
    eq(s.rows, 1200);
    eq(s.columns, 8);
    eq(s.numeric_columns, 4);
});
t('get_sensitive_columns returns ranked list', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const cols = AgentTools.get_sensitive_columns(ctx);
    gt(cols.length, 0, 'Expected sensitive columns');
    eq(cols[0].column, 'email', 'email should be most sensitive');
});
t('get_privacy_metrics returns all three sections', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const pm = AgentTools.get_privacy_metrics(ctx);
    notNull(pm.risk_metrics);
    notNull(pm.privacy_components);
    ok(Array.isArray(pm.threats));
});
t('get_pii_findings returns pii_columns, suggestions, and governance', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const pii = AgentTools.get_pii_findings(ctx);
    ok(pii.pii_columns.includes('email'));
    ok(Array.isArray(pii.cleaning_suggestions));
    ok(Array.isArray(pii.governance_actions));
});
t('get_pii_findings cleaning suggestions are scoped to PII columns only', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const pii = AgentTools.get_pii_findings(ctx);
    pii.cleaning_suggestions.forEach(s => {
        ok(pii.pii_columns.includes(s.column), `Non-PII column ${s.column} in PII suggestions`);
    });
});
t('get_recent_alerts returns array', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    ok(Array.isArray(AgentTools.get_recent_alerts(ctx)));
});
t('get_anomalies returns detected anomalies', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const anoms = AgentTools.get_anomalies(ctx);
    gt(anoms.length, 0);
});
t('get_column_stats with name returns single column', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const stats = AgentTools.get_column_stats(ctx, 'income');
    eq(stats.length, 1);
    eq(stats[0].name, 'income');
    eq(stats[0].type, 'numeric');
});
t('get_column_stats without name returns all columns', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const stats = AgentTools.get_column_stats(ctx);
    eq(stats.length, 8);
});
t('get_sql_schema returns valid table name and all columns', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const schema = AgentTools.get_sql_schema(ctx);
    eq(schema.table, 'customers_csv');
    eq(schema.columns.length, 8);
    ok(schema.columns.every(c => c.name && c.type), 'All columns must have name and type');
});
t('SQL schema marks PII columns', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const schema = AgentTools.get_sql_schema(ctx);
    const emailCol = schema.columns.find(c => c.name === 'email');
    ok(emailCol?.is_pii === true, 'email should be marked as PII in schema');
});
t('SQL schema marks non-PII columns as not PII', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const schema = AgentTools.get_sql_schema(ctx);
    const ageCol = schema.columns.find(c => c.name === 'age');
    ok(ageCol?.is_pii !== true, 'age should not be PII');
});
t('SQL column types correct: numeric→NUMERIC, categorical→VARCHAR', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const schema = AgentTools.get_sql_schema(ctx);
    const income = schema.columns.find(c => c.name === 'income');
    eq(income?.type, 'NUMERIC');
    const gender = schema.columns.find(c => c.name === 'gender');
    eq(gender?.type, 'VARCHAR');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 8 — LLM Context Formatter (Part 2)
// ─────────────────────────────────────────────────────────────────────────────
suite('Suite 8 — LLM Context Formatter');

t('formatContextForLLM includes DATASET ANALYSIS CONTEXT header', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '## DATASET ANALYSIS CONTEXT');
});
t('Format includes row count', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '1200', 'Should contain row count');
});
t('Format includes exact dataset risk score', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '62.4', 'Should contain exact risk score');
});
t('Format includes privacy score percentage', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '73.0%');
});
t('Format includes PII columns section', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '### PII Columns');
    contains(txt, 'email');
});
t('Format includes sensitive column scores', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, 'email');
    contains(txt, '0.940', 'Should cite email score');
});
t('Format includes anomaly section when anomalies exist', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '### Detected Anomalies');
    contains(txt, 'Distribution drift');
});
t('Format includes Agent Reasoning Rules', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, 'R1:', 'Should contain reasoning rule R1');
    contains(txt, 'R2:', 'Should contain reasoning rule R2');
    contains(txt, 'Never fabricate', 'Should include no-fabrication rule');
});
t('Format for empty pipeline is short and has_data hint', () => {
    const ctx = buildDatasetContext(EMPTY_PIPELINE);
    // formatContextForLLM always produces something — just not much
    const txt = formatContextForLLM(ctx);
    contains(txt, '## DATASET ANALYSIS CONTEXT');
    // Should show 'unknown' rows and 0 columns
    contains(txt, 'unknown');
});
t('Column drift values cited in anomaly detail', () => {
    const ctx = buildDatasetContext(RICH_PIPELINE);
    const txt = formatContextForLLM(ctx);
    contains(txt, '0.3400', 'Should cite income drift score in anomalies');
});

// ─────────────────────────────────────────────────────────────────────────────
// Print results
// ─────────────────────────────────────────────────────────────────────────────

const total = _pass + _fail;
process.stdout.write('\n══════════════════════════════════════════════════════════════\n');
process.stdout.write(`  AutoMate Aurora — Phase 5 AI Agent Test Suite\n`);
process.stdout.write(`  Results: ${_pass}/${total} passed`);
if (_fail > 0) {
    process.stdout.write(`  |  ${_fail} FAILED\n`);
    process.stdout.write('\nFailed tests:\n');
    _failedTests.forEach(n => process.stdout.write(`  ✗ ${n}\n`));
} else {
    process.stdout.write('  — ALL PASSED ✅\n');
}
process.stdout.write('══════════════════════════════════════════════════════════════\n\n');
process.exit(_fail > 0 ? 1 : 0);
