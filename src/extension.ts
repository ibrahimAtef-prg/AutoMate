import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { log } from './utils/logger';
import { buildMonitorHtml, DashboardData } from './webview/monitorPanel';
import { LeakageOutput, ThreatDetail, PrivacyComponents, ScanReport, BaselineArtifact, GeneratorOutput, validateLeakageOutput, validateMetrics, ValidationResult, PipelineMetrics, CheckpointEntry } from './webview/types/governance';
import { activateRealtimeScanner, deactivateRealtimeScanner } from './security/realtime_scanner';
import { scanPrompt } from './security/prompt_scanner';
import { OpenRouterClient, PipelineContext, LLMResponse } from './ai/openrouter_client';
import { onAlert, getRecentAlerts, SecurityAlert } from './security/alert_store';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A — Versioned payload sequencing
// ─────────────────────────────────────────────────────────────────────────────
interface VersionedPayload {
    id: string;
    seq: number;
    timestamp: number;
}
let _lastAppliedSeq = -1;
function checkSequence(incoming: VersionedPayload): boolean {
    if (incoming.seq <= _lastAppliedSeq) { return false; }
    _lastAppliedSeq = incoming.seq;
    return true;
}
function nextSeq(): number { return ++_lastAppliedSeq; }

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C — Strict JSON parser (reject arrays, primitives, unknown root types)
// ─────────────────────────────────────────────────────────────────────────────
function safeParse(raw: string): Record<string, unknown> {
    if (raw.length > MAX_PAYLOAD_BYTES) {
        throw new Error(`INPUT_TOO_LARGE: payload ${raw.length} bytes exceeds limit ${MAX_PAYLOAD_BYTES}`);
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('INVALID_ROOT: JSON root must be a plain object, not array/null/primitive');
    }
    // Reject stringified numbers masquerading as objects
    if (Object.keys(parsed as object).length === 0 && raw.trim() !== '{}') {
        throw new Error('INVALID_ROOT: empty object from non-empty string indicates encoding error');
    }
    return parsed as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP F — Prototype pollution guard
// ─────────────────────────────────────────────────────────────────────────────
function guardPrototypePollution(obj: unknown, label: string): void {
    if (obj === null || typeof obj !== 'object') { return; }
    const keys = Object.keys(obj as object);
    for (const k of keys) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
            throw mkError('PROTOTYPE_POLLUTION', `Prototype pollution attempt detected in ${label} (key: ${k})`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP J — Structured error factory
// ─────────────────────────────────────────────────────────────────────────────
interface StructuredError {
    type: 'PIPELINE_ERROR';
    code: string;
    message: string;
    stack?: string;
}
function mkError(code: string, message: string, original?: unknown): StructuredError {
    const e: StructuredError = { type: 'PIPELINE_ERROR', code, message };
    if (process.env.VSCODE_DEBUG_MODE === '1' && original instanceof Error) {
        e.stack = original.stack;
    }
    return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP K — Object depth guard
// ─────────────────────────────────────────────────────────────────────────────
const MAX_DEPTH = 50;
function checkDepth(obj: unknown, depth = 0, label = 'object'): void {
    if (depth > MAX_DEPTH) {
        throw mkError('DEPTH_LIMIT', `Object depth exceeds ${MAX_DEPTH} in ${label}`);
    }
    if (obj !== null && typeof obj === 'object') {
        for (const v of Object.values(obj as Record<string, unknown>)) {
            checkDepth(v, depth + 1, label);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP P — Payload size limit (2MB hard cap)
// ─────────────────────────────────────────────────────────────────────────────
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB

// ─────────────────────────────────────────────────────────────────────────────
// GROUP D — TS-side metric invariant check
// ─────────────────────────────────────────────────────────────────────────────
function assertMetricInvariants(m: PipelineMetrics): void {
    if (m.total_pipeline_time_ms < m.generation_time_ms) {
        throw mkError(
            'METRIC_INVARIANT',
            `total_pipeline_time_ms (${m.total_pipeline_time_ms}) < generation_time_ms (${m.generation_time_ms})`
        );
    }
    if (m.generation_time_ms > 0 && m.throughput_rows_per_sec > 0) {
        // Soft check: allow 2% tolerance for float round-trip imprecision
        const expected = (m.rows_analysed ?? 0) / (m.generation_time_ms / 1000);
        const diff = Math.abs(m.throughput_rows_per_sec - expected);
        if (diff > Math.max(1, expected * 0.02)) {
            throw mkError(
                'METRIC_INVARIANT',
                `throughput_rows_per_sec (${m.throughput_rows_per_sec}) != rows/gen_sec (${expected.toFixed(4)})`
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP R — Structured event logger
// ─────────────────────────────────────────────────────────────────────────────
interface StructuredEvent {
    eventId: string;
    timestamp: number;
    state: string;
    detail?: unknown;
}
let _eventCounter = 0;
function logEvent(state: string, detail?: unknown): StructuredEvent {
    const ev: StructuredEvent = {
        eventId: `ext-${++_eventCounter}`,
        timestamp: Date.now(),
        state,
        detail,
    };
    // Only emit to logger in debug builds — never in production
    if (process.env.VSCODE_DEBUG_MODE === '1') {
        log.debug('[EVENT] ' + ev.state, { eventId: ev.eventId, detail: ev.detail });
    }
    return ev;
}

/** Narrow type for OpenRouterClient extended with agent methods (added via prototype). */
type AgentClient = import('./ai/openrouter_client').OpenRouterClient & {
    agentChat: (history: unknown[], msg: string, ctx: unknown) => Promise<{ content: string; error?: string }>;
    explainDataset: (ctx: unknown) => Promise<{ content: string; error?: string }>;
    detectAnomalies: (ctx: unknown) => Promise<{ content: string; error?: string }>;
    suggestCleaning: (ctx: unknown) => Promise<{ content: string; error?: string }>;
    generateSQL: (q: string, ctx: unknown) => Promise<{ content: string; error?: string }>;
    recommendGovernance: (ctx: unknown) => Promise<{ content: string; error?: string }>;
};


/*
  AutoMate Aurora — Privacy Dashboard Extension
  Pipeline: parse.py → baseline.py → generator.py → leakage_bridge.py
  Dashboard: src/webview/monitorPanel.ts
*/

// ─────────────────────────────────────────────────────────────────────────────
// Python resolver
// ─────────────────────────────────────────────────────────────────────────────
function resolvePythonCommand(): string {
    const config = vscode.workspace.getConfiguration('idelense');
    const userPath = config.get<string>('pythonPath');
    if (userPath && userPath.trim()) { return userPath.trim(); }
    if (process.platform === 'win32') { return 'py'; }
    if (process.platform === 'darwin') { return 'python3'; }
    return 'python3';
}

function getPipelineDir(): string {
    const config = vscode.workspace.getConfiguration('idelense');
    return config.get<string>('pipelinePath') ?? '';
}

async function pushInsightsToPanel(panel: vscode.WebviewPanel): Promise<void> {
    try {
        const insights = await fetch('http://localhost:8000/insights').then(r => r.json());
        panel.webview.postMessage({
            type: 'insights',
            data: insights,
        });
    } catch (err: unknown) {
        const msg = `Insights fetch failed: ${String(err)}`;
        log.warn('[AutoMate] insights fetch failed', { error: msg });
        panel.webview.postMessage({
            type: 'insightsError',
            message: msg,
        });
    }
}

type FullPipelineResponse = {
    parse: Record<string, unknown>;
    baseline: BaselineArtifact;
    generate: GeneratorOutput;
    analysis: {
        decision: Record<string, unknown> | null;
        trust: Record<string, unknown> | null;
    };
    mode: 'system';
};

async function runFullPipelineApi(filePath: string, n: number): Promise<FullPipelineResponse> {
    const form = new FormData();
    const bytes = fs.readFileSync(filePath);
    form.append('file', new Blob([bytes]), path.basename(filePath));

    const response = await fetch(`http://localhost:8000/full?n=${encodeURIComponent(String(n))}`, {
        method: 'POST',
        body: form,
    });

    const rawText = await response.text();
    let parsed: unknown = {};
    if (rawText.trim()) {
        try {
            parsed = JSON.parse(rawText);
        } catch {
            throw new Error(`/full returned invalid JSON: ${rawText.slice(0, 200)}`);
        }
    }

    if (!response.ok) {
        const detail =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'detail' in parsed
                ? String((parsed as Record<string, unknown>).detail)
                : (rawText || `HTTP ${response.status}`);
        throw new Error(`/full failed (${response.status}): ${detail}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('/full contract violation: response is not an object');
    }

    const payload = parsed as Record<string, unknown>;
    if (payload.mode !== 'system') {
        throw new Error('/full contract violation: mode must be "system"');
    }

    const analysis = payload.analysis;
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
        throw new Error('/full contract violation: missing analysis object');
    }

    if (!("decision" in analysis) || !("trust" in analysis)) {
        throw new Error('/full contract violation: analysis.decision/trust missing');
    }

    return payload as FullPipelineResponse;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions matching leakage_bridge.py output contract
// ─────────────────────────────────────────────────────────────────────────────
/**
 * LeakageResult — type alias for the canonical LeakageOutput from governance.ts.
 *
 * ISS-004 / Phase 7 fix: eliminates the 3rd competing LeakageResult definition.
 * extension.ts previously defined its own interface with only 14 fields while
 * leakage_bridge.py emits 27. The missing fields were silently undefined when
 * passed to the webview via postMessage.
 *
 * Using LeakageOutput directly means:
 *   - Any field added to the schema is automatically available here.
 *   - Any field removed from the schema causes a TS compile error here.
 *   - The postMessage payload shape is guaranteed to match what governance.ts
 *     declares as the validated type.
 */
type LeakageResult = LeakageOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Extension activation
// ─────────────────────────────────────────────────────────────────────────────
// ── Global LLM client (shared across commands) ──────────────────────────────
let llmClient: OpenRouterClient;

export function activate(context: vscode.ExtensionContext) {

    llmClient = new OpenRouterClient();
    // Restore provider + key previously saved via the webview API key input
    const savedProviders = ['openrouter', 'openai', 'anthropic', 'groq', 'together', 'mistral'];
    // Try to detect the last used provider by checking which one has a saved key
    // (We check all and restore the most-recently-relevant one — openrouter last as legacy fallback)
    let restoredAny = false;
    for (const prov of savedProviders) {
        const pk = context.workspaceState.get<string>(`automate.apiKey.${prov}`, '');
        if (pk && pk !== 'PASTE_API_KEY_HERE') {
            llmClient.setKey(pk, prov as import('./ai/openrouter_client').AIProvider);
            restoredAny = true;
            break; // restore the first found; the webview will override on tab open
        }
    }
    if (!restoredAny) {
        // Legacy: try old openrouterApiKey setting
        const savedKey = context.workspaceState.get<string>('automate.openrouterApiKey', '');
        if (savedKey && savedKey !== 'PASTE_API_KEY_HERE') {
            llmClient.setKey(savedKey, 'openrouter');
        }
    }
    const provider = new DataImportCodeLensProvider();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider)
    );

    // ── Real-time security scanner ───────────────────────────────────────
    activateRealtimeScanner(context);

    // ── Live alert forwarding to open dashboard panels ───────────────────
    // Panels register themselves here when they open (see showCheckpointMonitor)
    const _activePanels: Set<vscode.WebviewPanel> = new Set();
    (global as Record<string, unknown>).__automatePanels = _activePanels;

    const unsubAlert = onAlert((alert: SecurityAlert) => {
        _activePanels.forEach(p => {
            try {
                p.webview.postMessage({ type: 'liveSecurityAlert', alert });
            } catch { /* panel disposed */ }
        });
    });

    // ── Existing: Parse Dataset command ──────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand("idelense.parseDataset", async (lineText: string) => {
            const fileName = extractPathFromImport(lineText);
            const editor = vscode.window.activeTextEditor;
            if (!editor || !fileName) {
                vscode.window.showErrorMessage("Could not resolve dataset path.");
                return;
            }
            const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
            const filePath = path.join(workspaceDir, fileName);
            try {
                const kind = detectKind(filePath);
                const ast = await runPythonParser(context, filePath);
                const baseline = await runBaseline(context, filePath, kind);
                // Store for dashboard "Run Generator" button
                lastFilePath = filePath;
                lastBaseline = baseline;
                lastAst = ast;
                showCombinedResult(context, ast, baseline, filePath);
            } catch (err: unknown) {
                vscode.window.showErrorMessage("Parser Error: " + err);
            }
        })
    );

    // ── Existing: Generate Synthetic ─────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('idelense.generateSynthetic', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('IDE Lense: Open a Python file that imports a dataset first.');
                return;
            }
            vscode.window.showInformationMessage('IDE Lense: Click the "Parse Dataset (IDE Lense)" lens above your dataset import line.');
        })
    );

    // ── NEW: Scan Dataset for PII ────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.scanDataset', async () => {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
                title: 'Select dataset to scan for PII'
            });
            if (!fileUri || !fileUri[0]) { return; }
            const filePath = fileUri[0].fsPath;
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AutoMate: Scanning for PII & secrets…',
                cancellable: false
            }, async () => {
                try {
                    const report = await runPIIScan(context, filePath);
                    showScanReport(context, report, filePath);
                } catch (err: unknown) {
                    vscode.window.showErrorMessage('Scan failed: ' + err);
                }
            });
        })
    );

    // ── NEW: Anonymize Dataset ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.anonymizeDataset', async () => {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { 'Datasets': ['csv', 'json', 'xlsx'] },
                title: 'Select dataset to anonymize'
            });
            if (!fileUri || !fileUri[0]) { return; }
            const filePath = fileUri[0].fsPath;
            const ext = path.extname(filePath);
            const outputPath = filePath.replace(ext, `_anonymized${ext}`);
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AutoMate: Anonymizing dataset…',
                cancellable: false
            }, async () => {
                try {
                    const result = await runAnonymizer(context, filePath, outputPath);
                    vscode.window.showInformationMessage(
                        `Anonymized: ${result.cells_anonymized} cells in ${result.anonymized_columns?.length || 0} columns. Saved to ${outputPath}`,
                    );
                } catch (err: unknown) {
                    vscode.window.showErrorMessage('Anonymization failed: ' + err);
                }
            });
        })
    );

    // ── NEW: Run Attack Simulation ───────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.runAttackSimulation', async () => {
            const origUri = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
                title: 'Select ORIGINAL dataset'
            });
            if (!origUri?.[0]) { return; }
            const synthUri = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
                title: 'Select SYNTHETIC dataset'
            });
            if (!synthUri?.[0]) { return; }
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AutoMate: Running attack simulations…',
                cancellable: false
            }, async () => {
                try {
                    const report = await runAttackSim(context, origUri[0].fsPath, synthUri[0].fsPath);
                    showAttackReport(context, report);
                } catch (err: unknown) {
                    vscode.window.showErrorMessage('Attack simulation failed: ' + err);
                }
            });
        })
    );

    // ── NEW: Generate Dataset Card ───────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.generateDatasetCard', async () => {
            vscode.window.showInformationMessage(
                'AutoMate: Dataset cards are auto-generated when you run the full pipeline from Parse Dataset.'
            );
        })
    );

    // ── NEW: Scan Prompt for Leakage ─────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.scanPrompt', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('Select text first.');
                return;
            }
            const selection = editor.document.getText(editor.selection);
            const textToScan = selection || editor.document.getText();
            const result = scanPrompt(textToScan);
            if (result.isClean) {
                vscode.window.showInformationMessage('✅ Prompt is clean — no sensitive data detected.');
            } else {
                const action = await vscode.window.showWarningMessage(
                    `⚠ ${result.summary}`,
                    'Show Anonymized Version', 'Dismiss'
                );
                if (action === 'Show Anonymized Version') {
                    const doc = await vscode.workspace.openTextDocument({ content: result.anonymizedPrompt, language: 'text' });
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                }
            }
        })
    );

    // ── NEW: Ask AI about Data ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.askAI', async () => {
            if (!llmClient.isConfigured()) {
                const action = await vscode.window.showWarningMessage(
                    'AutoMate AI requires an OpenRouter API key (free tier). Set "automate.openrouterApiKey" in settings.',
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'automate.openrouterApiKey');
                }
                return;
            }
            const question = await vscode.window.showInputBox({
                prompt: 'Ask the AI about your dataset, privacy analysis, or synthetic data…',
                placeHolder: 'e.g., What are the top privacy risks in this dataset?'
            });
            if (!question) { return; }
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'AutoMate AI is thinking…',
                cancellable: false
            }, async () => {
                const response = await llmClient.askAboutData(question, lastPipelineContext);
                if (response.error) {
                    vscode.window.showErrorMessage('AI Error: ' + response.error);
                } else {
                    const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                }
            });
        })
    );

    // ── Phase 5: Agent Commands ───────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('automate.explainDataset', async () => {
            if (!llmClient.isConfigured()) {
                vscode.window.showWarningMessage('AutoMate AI requires an OpenRouter API key. Set "automate.openrouterApiKey" in settings.');
                return;
            }
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Explaining dataset…', cancellable: false }, async () => {
                const response = await llmClient.explainDataset(lastPipelineContext);
                if (response.error) { vscode.window.showErrorMessage('AI Error: ' + response.error); return; }
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('automate.detectAnomalies', async () => {
            if (!llmClient.isConfigured()) { vscode.window.showWarningMessage('OpenRouter API key required.'); return; }
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Detecting anomalies…', cancellable: false }, async () => {
                const response = await llmClient.detectAnomalies(lastPipelineContext);
                if (response.error) { vscode.window.showErrorMessage('AI Error: ' + response.error); return; }
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('automate.suggestCleaning', async () => {
            if (!llmClient.isConfigured()) { vscode.window.showWarningMessage('OpenRouter API key required.'); return; }
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Generating cleaning suggestions…', cancellable: false }, async () => {
                const response = await llmClient.suggestCleaning(lastPipelineContext);
                if (response.error) { vscode.window.showErrorMessage('AI Error: ' + response.error); return; }
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('automate.generateSQL', async () => {
            if (!llmClient.isConfigured()) { vscode.window.showWarningMessage('OpenRouter API key required.'); return; }
            const question = await vscode.window.showInputBox({
                prompt: 'Describe the SQL query you need (e.g., "Find users with income > 100k")',
                placeHolder: 'e.g., Find all records where age > 18 and email is not null'
            });
            if (!question) { return; }
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Generating SQL…', cancellable: false }, async () => {
                const response = await llmClient.generateSQL(question, lastPipelineContext);
                if (response.error) { vscode.window.showErrorMessage('AI Error: ' + response.error); return; }
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'sql' });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('automate.recommendGovernance', async () => {
            if (!llmClient.isConfigured()) { vscode.window.showWarningMessage('OpenRouter API key required.'); return; }
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Building governance plan…', cancellable: false }, async () => {
                const response = await llmClient.recommendGovernance(lastPipelineContext);
                if (response.error) { vscode.window.showErrorMessage('AI Error: ' + response.error); return; }
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            });
        })
    );

    // ── Open Aurora Dashboard directly (standalone, without prior generate) ─
    context.subscriptions.push(
        vscode.commands.registerCommand('automate.openDashboard', () => {
            const chartUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js');
            const emptyData = {
                result: null, leakage: null, ast: null, baseline: null,
                cp: null, checkpoint: null,
                chartUri: '', scanReport: null, attackReport: null,
                knowledgeGraph: null, lineage: null,
            };
            showCheckpointMonitor(
                context,
                {
                    generator_used: '',
                    row_count: 0,
                    samples: [],
                    quality_score: null,
                    warnings: [],
                    label_distribution_applied: null,
                    metrics: null,
                },
                null, undefined, undefined, undefined, undefined, undefined, undefined
            );
        })
    );
}

export function deactivate() {
    deactivateRealtimeScanner();
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeLens provider
// ─────────────────────────────────────────────────────────────────────────────
class DataImportCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const ranges = detectDataImports(document);
        return ranges.map(range => new vscode.CodeLens(range, {
            title: "Parse Dataset (IDE Lense)",
            command: "idelense.parseDataset",
            arguments: [document.lineAt(range.start.line).text]
        }));
    }
}

function detectDataImports(document: vscode.TextDocument): vscode.Range[] {
    const regex = /(read_csv|read_excel|read_json|read_parquet|spark\.read)/g;
    const ranges: vscode.Range[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (regex.test(line.text)) { ranges.push(line.range); }
        regex.lastIndex = 0;
    }
    return ranges;
}

function extractPathFromImport(line: string): string | null {
    const match = line.match(/['"]([^'"]+\.(csv|xlsx|json|parquet))['"]/);
    return match ? match[1] : null;
}

function detectKind(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".csv") { return "csv"; }
    if (ext === ".xlsx") { return "excel"; }
    if (ext === ".json") { return "json"; }
    if (ext === ".parquet") { return "parquet"; }
    return "csv";
}

// ─────────────────────────────────────────────────────────────────────────────
// Python process helpers
// ─────────────────────────────────────────────────────────────────────────────
const _activeProcesses = new Set<cp.ChildProcessWithoutNullStreams>();

function spawnPython(py: string, args: string[], extraEnv?: Record<string, string>): cp.ChildProcessWithoutNullStreams {
    let proc: cp.ChildProcessWithoutNullStreams;
    try {
        proc = cp.spawn(py, args, {
            env: { ...process.env, PYTHONUNBUFFERED: "1", ...(extraEnv ?? {}) },
        });
        _activeProcesses.add(proc);
    } catch (e) {
        throw e;
    }
    proc.on('exit', () => {
        _activeProcesses.delete(proc);
    });
    proc.on('error', () => {
        _activeProcesses.delete(proc);
    });
    return proc;
}

function collectOutput(proc: cp.ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => stdout += d.toString());
        proc.stderr.on("data", (d: Buffer) => stderr += d.toString());
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
        proc.on("error", (err) => {
            reject(new Error("Process spawn failed: " + err.message));
        });
    });
}

function runPythonParser(context: vscode.ExtensionContext, filePath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "parse.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) { reject(stderr || `parse.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from parse.py'); return; }
        try {
            if (trimmed.length > MAX_PAYLOAD_BYTES) { reject('parse.py output exceeds 2MB limit'); return; }
            const parsed = safeParse(trimmed);
            guardPrototypePollution(parsed, 'parse.py output');
            checkDepth(parsed, 0, 'parse.py output');
            logEvent('parse.py:parsed', { size: trimmed.length });
            resolve(parsed);
        } catch (e) { reject(`Invalid JSON from parse.py: ${(e as Error).message}`); }
    });
}

function runBaseline(context: vscode.ExtensionContext, filePath: string, kind: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "baseline.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath, "--kind", kind]));
        if (code !== 0) { reject(stderr || `baseline.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from baseline.py'); return; }
        try {
            if (trimmed.length > MAX_PAYLOAD_BYTES) { reject('baseline.py output exceeds 2MB limit'); return; }
            const parsed = safeParse(trimmed);
            guardPrototypePollution(parsed, 'baseline.py output');
            checkDepth(parsed, 0, 'baseline.py output');
            logEvent('baseline.py:parsed', { size: trimmed.length });
            resolve(parsed);
        } catch (e) { reject(`Invalid JSON from baseline.py: ${(e as Error).message}`); }
    });
}

let _currentProc: cp.ChildProcessWithoutNullStreams | null = null;

function cancelGeneration() {
    if (_currentProc && !_currentProc.killed) {
        _currentProc.kill('SIGTERM');
        const proc = _currentProc;
        setTimeout(() => {
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
        }, 2000);
    }
}

function runGenerator(context: vscode.ExtensionContext, filePath: string, baselinePath: string, n: number): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir = path.join(workspaceDir, '.idelense', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const _genProc = spawnPython(py, [
            scriptPath, filePath, baselinePath, "--n", String(n), "--cache-dir", cacheDir
        ]);
        _currentProc = _genProc;
        // B6: always clear _currentProc when process exits, regardless of outcome
        _genProc.on('close', () => { _currentProc = null; });
        let result: { stdout: string; stderr: string; code: number | null };
        try {
            result = await collectOutput(_genProc);
        } catch (spawnErr) {
            _currentProc = null;
            reject(spawnErr); return;
        }
        _currentProc = null;
        const { stdout, stderr, code } = result;
        if (code !== 0) { reject(stderr || `generator.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from generator.py'); return; }
        try {
            if (trimmed.length > MAX_PAYLOAD_BYTES) { reject('generator.py output exceeds 2MB limit'); return; }
            const parsed = safeParse(trimmed);
            guardPrototypePollution(parsed, 'generator.py output');
            checkDepth(parsed, 0, 'generator.py output');
            logEvent('generator.py:parsed', { size: trimmed.length });
            resolve(parsed);
        } catch (e) { reject(`Invalid JSON from generator.py: ${(e as Error).message}`); }
    });
}

/**
 * runLeakageAnalysis — always resolves (never rejects).
 * Returns the full LeakageResult contract with all required fields.
 */
function runLeakageAnalysis(
    context: vscode.ExtensionContext,
    originalFilePath: string,
    generatorResult: GeneratorOutput | null
): Promise<LeakageResult> {
    return new Promise(async (resolve) => {
        const errorResult = (msg: string): LeakageResult => ({
            risk_level: null,
            privacy_score: null,
            privacy_score_reliable: false,
            statistical_drift: null,
            duplicates_rate: null,
            membership_inference_auc: null,
            avg_drift_score: null,
            top_threats: [],
            threat_details: [],
            column_drift: {},
            reidentification_risk: {},
            sensitive_column_ranking: [],
            has_uncertainty: true,
            uncertainty_notes: [msg],
            error: msg,
            _mode: "error",
            privacy_components: { duplicates_risk: 0, mi_attack_risk: 0, distance_similarity_risk: 0, distribution_drift_risk: 0 },
            attack_results: {
                membership_attack_success: null,
                reconstruction_risk: null,
                nearest_neighbor_leakage: null,
            },
            num_cols_analysed: null,
            cat_cols_analysed: null,
            n_samples: null,
            dataset_risk_score: null,
            statistical_reliability_score: null,
            pii_columns: [],
            outlier_risk: [],
            dataset_intelligence_risk: {
                score: null,
                label: null,
                breakdown: {},
            },
            privacy_recommendations: [],
        });

        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "leakage_bridge.py");
        const n = generatorResult?.row_count ?? 500;
        const pipelineDir = getPipelineDir();
        const args: string[] = [scriptPath, "--original", originalFilePath, "--n", String(n)];
        if (pipelineDir) { args.push("--pipeline-dir", pipelineDir); }

        let proc: cp.ChildProcessWithoutNullStreams;
        try {
            proc = spawnPython(py, args);
        } catch (spawnErr: unknown) {
            resolve(errorResult(`Could not start leakage_bridge.py: ${(spawnErr instanceof Error ? spawnErr.message : String(spawnErr))}`));
            return;
        }

        const { stdout, stderr } = await collectOutput(proc);
        const trimmed = stdout.trim();
        if (trimmed) {
            try {
                // Parse without unsafe cast — use unknown first, then validate
                const rawParsed: unknown = (() => {
                    if (trimmed.length > MAX_PAYLOAD_BYTES) {
                        throw mkError('INPUT_TOO_LARGE', `leakage_bridge output exceeds 2MB (${trimmed.length} bytes)`);
                    }
                    const p: unknown = JSON.parse(trimmed);
                    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
                        throw mkError('INVALID_ROOT', 'leakage_bridge.py output is not a plain JSON object');
                    }
                    guardPrototypePollution(p, 'leakage_bridge output');
                    checkDepth(p, 0, 'leakage_bridge output');
                    return p;
                })();
                logEvent('leakage_bridge.py:parsed', { size: trimmed.length });

                // rawParsed is already validated as a non-null, non-array object
                // by the inline parse block above (Groups C+F+K+P).
                // This secondary guard is retained as a defensive layer only.
                if (
                    rawParsed === null ||
                    Array.isArray(rawParsed) ||
                    typeof rawParsed !== 'object'
                ) {
                    resolve(errorResult('leakage_bridge.py output is not a plain JSON object'));
                    return;
                }

                const rawObj = rawParsed as Record<string, unknown>;
                let leakagePayload: unknown;
                let sidecarMetrics: PipelineMetrics | null = null;

                if (
                    'data' in rawObj &&
                    rawObj['data'] !== null &&
                    !Array.isArray(rawObj['data']) &&
                    typeof rawObj['data'] === 'object'
                ) {
                    // Canonical envelope format: {data: LeakageOutput, metrics: PipelineMetrics}
                    leakagePayload = rawObj['data'];

                    // Phase 2: ALL paths go through validateMetrics — no silent acceptance.
                    const rawMetrics = rawObj['metrics'];
                    if (rawMetrics !== undefined && rawMetrics !== null) {
                        if (!validateMetrics(rawMetrics)) {
                            resolve(errorResult(
                                'leakage_bridge.py metrics payload failed validation — ' +
                                'expected {generation_time_ms, total_pipeline_time_ms, throughput_rows_per_sec}'
                            ));
                            return;
                        }
                        sidecarMetrics = rawMetrics as PipelineMetrics;
                        // Group D: enforce TS-side metric invariants immediately
                        try { assertMetricInvariants(sidecarMetrics); }
                        catch (me) {
                            const err = mkError('METRIC_INVARIANT', (me as StructuredError).message || String(me));
                            resolve(errorResult(`Metrics invariant violation: ${err.message}`));
                            return;
                        }
                    }
                } else if ('risk_level' in rawObj || 'privacy_score' in rawObj) {
                    // Legacy flat format (old bridge version without envelope)
                    leakagePayload = rawParsed;
                } else {
                    // Neither envelope nor recognisable flat format — reject
                    resolve(errorResult(
                        'leakage_bridge.py output has unrecognised structure: ' +
                        'expected {data: LeakageOutput, metrics: ...} envelope or flat LeakageOutput'
                    ));
                    return;
                }

                const vr: ValidationResult = validateLeakageOutput(leakagePayload);
                if (!vr.valid) {
                    resolve(errorResult(
                        `leakage_bridge.py output failed schema validation — ` +
                        `missing=[${vr.missingFields.join(', ')}] ` +
                        `errors=[${vr.errors.join('; ')}]`
                    ));
                    return;
                }
                // Safe cast: only after explicit schema validation passes
                const parsed: LeakageResult = leakagePayload as LeakageResult;

                // Backfill privacy_components if absent (handles pipeline-mode output
                // which may omit it — Python validation allows null).
                if (!parsed.privacy_components) {
                    const auc = parsed.membership_inference_auc;
                    parsed.privacy_components = {
                        duplicates_risk: parsed.duplicates_rate ?? 0,
                        mi_attack_risk: Math.max(0, ((auc ?? 0.5) - 0.5) * 2),
                        distance_similarity_risk: Math.max(0, (0.5 - (auc ?? 0.5)) * 2),
                        distribution_drift_risk: Object.keys(parsed.column_drift ?? {}).length
                            ? Object.values(parsed.column_drift ?? {}).reduce((a, b) => a + b, 0) / Object.values(parsed.column_drift ?? {}).length
                            : 0,
                    };
                }
                // Fix 1: resolve full envelope so trust/decision/interpretation are forwarded
                const fullEnvelope = Object.assign({}, rawObj, parsed);
                resolve(fullEnvelope as LeakageResult);
                void sidecarMetrics; // sidecarMetrics surfaced via generator result.metrics
                return;
            } catch (err: unknown) {
                // Phase 9: normalize all errors to a consistent message shape
                const msg = err instanceof Error ? err.message : String(err);
                resolve(errorResult(`leakage_bridge.py parse error: ${msg.slice(0, 200)}`));
                return;
            }
        }
        resolve(errorResult(stderr.trim() || "leakage_bridge.py exited with no output"));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline context for LLM (updated after each full run)
// ─────────────────────────────────────────────────────────────────────────────
let lastPipelineContext: PipelineContext = {};

// ─────────────────────────────────────────────────────────────────────────────
// Per-panel session state — isolates file/baseline per open panel instance
// ─────────────────────────────────────────────────────────────────────────────
const sessionState = new Map<string, any>();
let lastFilePath: string | null = null;
let lastBaseline: Record<string, unknown> | null = null;
let lastAst: Record<string, unknown> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// New Python process runners
// ─────────────────────────────────────────────────────────────────────────────
function runPIIScan(context: vscode.ExtensionContext, filePath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'data_scanner.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) { reject(stderr || `data_scanner.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from data_scanner.py'); return; }
        try {
            const p = safeParse(trimmed); guardPrototypePollution(p, 'data_scanner'); checkDepth(p, 0, 'data_scanner');
            logEvent('data_scanner.py:parsed', { size: trimmed.length }); resolve(p);
        } catch (e) { reject(`Invalid JSON from data_scanner.py: ${(e as Error).message}`); }
    });
}

function runAnonymizer(context: vscode.ExtensionContext, filePath: string, outputPath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'anonymizer.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, filePath, '--output', outputPath
        ]));
        if (code !== 0) { reject(stderr || `anonymizer.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from anonymizer.py'); return; }
        try {
            const p = safeParse(trimmed); guardPrototypePollution(p, 'anonymizer'); checkDepth(p, 0, 'anonymizer');
            logEvent('anonymizer.py:parsed', { size: trimmed.length }); resolve(p);
        } catch (e) { reject(`Invalid JSON from anonymizer.py: ${(e as Error).message}`); }
    });
}

function runAttackSim(context: vscode.ExtensionContext, originalPath: string, syntheticPath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'privacy', 'attack_simulator.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--original', originalPath, '--synthetic', syntheticPath
        ]));
        if (code !== 0) { reject(stderr || `attack_simulator.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from attack_simulator.py'); return; }
        try {
            const p = safeParse(trimmed); guardPrototypePollution(p, 'attack_simulator'); checkDepth(p, 0, 'attack_simulator');
            logEvent('attack_simulator.py:parsed', { size: trimmed.length }); resolve(p);
        } catch (e) { reject(`Invalid JSON from attack_simulator.py: ${(e as Error).message}`); }
    });
}

function runKnowledgeGraph(context: vscode.ExtensionContext, baselinePath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'knowledge_graph.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--baseline', baselinePath
        ]));
        if (code !== 0) { reject(stderr || `knowledge_graph.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from knowledge_graph.py'); return; }
        try {
            const p = safeParse(trimmed); guardPrototypePollution(p, 'knowledge_graph'); checkDepth(p, 0, 'knowledge_graph');
            logEvent('knowledge_graph.py:parsed', { size: trimmed.length }); resolve(p);
        } catch (e) { reject(`Invalid JSON from knowledge_graph.py: ${(e as Error).message}`); }
    });
}

function runDocGenerator(
    context: vscode.ExtensionContext,
    baselinePath: string,
    leakagePath?: string,
    scanPath?: string,
    attackPath?: string,
    outputPath?: string
): Promise<string> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'doc_generator.py');
        const args = [scriptPath, '--baseline', baselinePath];
        if (leakagePath) { args.push('--leakage', leakagePath); }
        if (scanPath) { args.push('--scan', scanPath); }
        if (attackPath) { args.push('--attack', attackPath); }
        if (outputPath) { args.push('--output', outputPath); }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) { reject(stderr || `doc_generator.py exited ${code}`); return; }
        resolve(stdout);
    });
}

function runLineageBuilder(
    context: vscode.ExtensionContext,
    sourcePath: string,
    baselinePath?: string,
    leakagePath?: string
): Promise<any> {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'lineage.py');
        const args = [scriptPath, '--source', sourcePath];
        if (baselinePath) { args.push('--baseline', baselinePath); }
        if (leakagePath) { args.push('--leakage', leakagePath); }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) { reject(stderr || `lineage.py exited ${code}`); return; }
        const trimmed = stdout.trim();
        if (!trimmed) { reject('Empty output from lineage.py'); return; }
        try {
            const p = safeParse(trimmed); guardPrototypePollution(p, 'lineage'); checkDepth(p, 0, 'lineage');
            logEvent('lineage.py:parsed', { size: trimmed.length }); resolve(p);
        } catch (e) { reject(`Invalid JSON from lineage.py: ${(e as Error).message}`); }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Show PII scan report in a new panel
// ─────────────────────────────────────────────────────────────────────────────
function showScanReport(context: vscode.ExtensionContext, report: ScanReport, filePath: string): void {
    const panel = vscode.window.createWebviewPanel(
        'automateScanReport', 'AutoMate — PII Scan Report',
        vscode.ViewColumn.Beside, { enableScripts: true }
    );
    const n_pii = report.pii_findings?.length || 0;
    const n_sec = report.secrets?.length || 0;
    const n_sen = report.sensitive_content?.length || 0;
    const riskColor = report.risk_score > 70 ? '#ef4444' : report.risk_score > 30 ? '#f59e0b' : '#10b981';
    const findings: Record<string, unknown>[] = [
        ...(report.pii_findings as unknown as Record<string, unknown>[]),
        ...(report.secrets as Record<string, unknown>[]),
        ...(report.sensitive_content as Record<string, unknown>[]),
    ];
    const findingsHtml = findings
        .slice(0, 50)
        .map((f) => {
            const type = typeof f.type === 'string' ? f.type : 'finding';
            const category = typeof f.category === 'string' ? f.category : '—';
            const column = typeof f.column === 'string' ? f.column : '—';
            const severity = typeof f.severity === 'string' ? f.severity : '—';
            const preview = typeof f.value_preview === 'string'
                ? f.value_preview
                : (typeof f.sample === 'string' ? f.sample : '—');
            return `<tr><td>${esc(type)}</td><td>${esc(category)}</td><td>${esc(column)}</td><td>${esc(severity)}</td><td>${esc(preview)}</td></tr>`;
        })
        .join('');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:#ede5f8;background:#0f0f17;padding:20px}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;color:#9080b0;display:block;margin-bottom:2px}
.stat-box span{font-size:18px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
th{text-align:left;padding:5px 8px;background:#1a1a2e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#9080b0}
td{padding:5px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
</style></head><body>
<div class="card"><h2>🛡️ PII & Security Scan Report</h2><p style="font-size:11px;color:#9080b0">${esc(path.basename(filePath))}</p></div>
<div class="card"><div class="stat-grid">
<div class="stat-box"><label>PII Findings</label><span style="color:#f59e0b">${n_pii}</span></div>
<div class="stat-box"><label>Secrets</label><span style="color:#ef4444">${n_sec}</span></div>
<div class="stat-box"><label>Sensitive</label><span style="color:#8b5cf6">${n_sen}</span></div>
<div class="stat-box"><label>Risk Score</label><span style="color:${riskColor}">${Math.round(report.risk_score)}/100</span></div>
</div></div>
<div class="card"><h2>📋 Findings (top 50)</h2>
<table><thead><tr><th>Type</th><th>Category</th><th>Column</th><th>Severity</th><th>Preview</th></tr></thead>
<tbody>${findingsHtml || '<tr><td colspan="5" style="text-align:center;padding:12px;color:#9080b0">✅ No findings — dataset appears clean.</td></tr>'}</tbody></table>
</div>
</body></html>`;
}

// Show attack simulation report
function showAttackReport(context: vscode.ExtensionContext, report: Record<string, unknown>): void {
    const panel = vscode.window.createWebviewPanel(
        'automateAttackReport', 'AutoMate — Attack Simulation',
        vscode.ViewColumn.Beside, { enableScripts: true }
    );
    const overallVulnerability = typeof report.overall_vulnerability === 'string' ? report.overall_vulnerability : 'unknown';
    const vulnColor = overallVulnerability === 'safe' ? '#10b981' :
        overallVulnerability === 'moderate' ? '#f59e0b' : '#ef4444';
    const results = Array.isArray(report.results) ? (report.results as Record<string, unknown>[]) : [];
    const resultsHtml = results.map((r) => {
        const success = Boolean(r.success);
        const severity = typeof r.severity === 'string' ? r.severity : 'unknown';
        const icon = success ? '❌' : '✅';
        const sevColor = severity === 'critical' ? '#ef4444' : severity === 'high' ? '#f59e0b' : '#10b981';
        const attackName = typeof r.attack_name === 'string' ? r.attack_name : 'Unknown Attack';
        const description = typeof r.description === 'string' ? r.description : '';
        const successRate = typeof r.success_rate === 'number' ? r.success_rate : 0;
        return `<div style="background:#1a1a2e;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${sevColor}">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-weight:600;color:#ede5f8">${icon} ${esc(attackName)}</span>
                <span style="font-size:10px;color:${sevColor};text-transform:uppercase">${esc(severity)}</span>
            </div>
            <p style="font-size:11px;color:#9080b0;margin-top:4px">${esc(description)}</p>
            <p style="font-size:10px;color:#7c6fa0;margin-top:2px">Success rate: ${(successRate * 100).toFixed(1)}%</p>
        </div>`;
    }).join('');
    const recommendations = Array.isArray(report.recommendations)
        ? report.recommendations.filter((r): r is string => typeof r === 'string')
        : [];
    const recsHtml = recommendations.map((r: string) =>
        `<li style="font-size:11px;color:#9080b0;margin-bottom:4px">💡 ${esc(r)}</li>`).join('');
    const summary = typeof report.summary === 'string' ? report.summary : '';
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--vscode-font-family,sans-serif);color:#ede5f8;background:#0f0f17;padding:20px}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
</style></head><body>
<div class="card"><h2>⚔️ Attack Simulation Report</h2>
<p style="font-size:12px;margin-bottom:8px">Vulnerability: <span style="color:${vulnColor};font-weight:700;text-transform:uppercase">${esc(overallVulnerability)}</span></p>
<p style="font-size:11px;color:#9080b0">${esc(summary)}</p></div>
<div class="card"><h2>Results</h2>${resultsHtml}</div>
${recsHtml ? `<div class="card"><h2>💡 Recommendations</h2><ul style="padding-left:16px">${recsHtml}</ul></div>` : ''}
</body></html>`;
}

// Simple HTML escape helper for report panels
function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse + Baseline panel (before generation)
// ─────────────────────────────────────────────────────────────────────────────
function showCombinedResult(context: vscode.ExtensionContext, ast: Record<string, unknown>, baseline: BaselineArtifact, filePath: string) {

    const panel = vscode.window.createWebviewPanel(
        "idelenseCombined",
        "IDE Lense — Parse + Baseline",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const astDs = ((ast as any)?.dataset ?? ast ?? {}) as Record<string, any>;
    const schemaFields: Array<{ name: string; type: string; nullable?: boolean }> = (astDs.schema?.fields ?? []) as Array<{ name: string; type: string; nullable?: boolean }>;
    const profile = (astDs.profile ?? {}) as Record<string, any>;
    const blNumCols = Object.keys(baseline?.columns?.numeric ?? {});
    const blCatCols = Object.keys(baseline?.columns?.categorical ?? {});

    const colRows = schemaFields.map((f) => {
        const isNum = blNumCols.includes(f.name);
        const isCat = blCatCols.includes(f.name);
        const tag = isNum ? 'numeric' : isCat ? 'categorical' : f.type ?? '—';
        const miss = profile.missingness?.[f.name];
        const misSt = miss != null ? Math.round(miss * 100) + '%' : '—';
        return `<tr>
          <td><b>${f.name}</b></td>
          <td><span style="font-size:10px;padding:1px 6px;border-radius:8px;
            background:${isNum ? 'rgba(139,92,246,.15)' : 'rgba(168,85,247,.1)'};
            color:${isNum ? '#a78bfa' : '#c084fc'}">${tag}</span></td>
          <td style="text-align:right">${f.nullable ? '✓' : '—'}</td>
          <td style="text-align:right">${misSt}</td>
        </tr>`;
    }).join('');

    panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:#ede5f8;background:#0f0f17;padding:20px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;background:#1a1a2e;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#9080b0}
td{padding:6px 8px;border-bottom:1px solid rgba(139,92,246,.08)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.stat-box label{font-size:10px;text-transform:uppercase;color:#9080b0;display:block;margin-bottom:2px}
.stat-box span{font-size:16px;font-weight:700;color:#c084fc}
.gen-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
input[type=number]{background:#1e1e2e;border:1px solid #2a2a3b;color:#ede5f8;border-radius:6px;padding:5px 8px;font-size:13px;width:90px}
button{background:linear-gradient(135deg,#7c3aed,#9333ea);color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:500}
button:hover{opacity:.85}
#status{font-size:12px;color:#9080b0;margin-top:8px}
</style></head><body>
<div class="card">
  <h2>📄 Dataset Overview</h2>
  <div class="stat-grid">
    <div class="stat-box"><label>Rows</label><span>${profile.row_count_estimate ?? baseline?.meta?.row_count ?? '—'}</span></div>
    <div class="stat-box"><label>Columns</label><span>${schemaFields.length || (blNumCols.length + blCatCols.length)}</span></div>
    <div class="stat-box"><label>Numeric</label><span>${blNumCols.length}</span></div>
    <div class="stat-box"><label>Categorical</label><span>${blCatCols.length}</span></div>
  </div>
</div>
<div class="card">
  <h2>🗂 Column Schema</h2>
  <table>
    <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Missing</th></tr></thead>
    <tbody>${colRows || '<tr><td colspan="4" style="text-align:center;padding:12px;color:#9080b0">No schema data</td></tr>'}</tbody>
  </table>
</div>
<div class="card">
  <h2>⚙️ Generate Synthetic Data</h2>
  <p style="font-size:12px;color:#9080b0;margin-bottom:12px">
    After generation completes, the Privacy Dashboard will open automatically.
  </p>
  <div class="gen-row">
    <label style="font-size:12px;color:#9080b0">Rows:</label>
    <input id="n" type="number" value="500" min="1"/>
    <button onclick="generate()">▶ Generate + Analyse</button>
  </div>
  <div id="status"></div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function generate() {
    const n = parseInt(document.getElementById('n').value, 10);
    document.getElementById('status').textContent = '⏳ Running generation pipeline…';
    vscode.postMessage({ command: 'generate', n });
  }
  window.addEventListener('message', e => {
    document.getElementById('status').textContent = e.data.text;
  });
</script>
</body></html>`;

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
        if (msg.command !== "generate") { return; }
        const tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(baseline));
        try {
            const requestedN = (typeof msg.n === 'number' && Number.isFinite(msg.n) && msg.n > 0)
                ? Math.floor(msg.n)
                : 500;
            panel.webview.postMessage({ text: '🌐 Running /full system pipeline…' });
            const fullResult = await runFullPipelineApi(filePath, requestedN);
            const result = fullResult.generate;
            const leakageResult: LeakageResult | null = null;
            const analysisDecision = fullResult.analysis?.decision ?? null;
            const analysisTrust = fullResult.analysis?.trust ?? null;
            const analysisInterpretation = null;
            const generatedSummary = (result as any)?.summary ?? null;
            const analysisBlock = {
                decision: analysisDecision,
                trust: analysisTrust,
                interpretation: analysisInterpretation,
            };
            const baselineForPayload = (fullResult.baseline ?? baseline) as BaselineArtifact;
            const astForPayload = (fullResult.parse ?? ast) as Record<string, unknown>;

            // ── Run extended analytics pipeline ──────────────────────────
            let scanReport: ScanReport | null = null;
            let attackReport: Record<string, unknown> | null = null;
            let knowledgeGraph: Record<string, unknown> | null = null;
            let lineageData: Record<string, unknown> | null = null;

            try {
                panel.webview.postMessage({ text: '🛡️ Running PII scan…' });
                scanReport = await runPIIScan(context, filePath);
            } catch { /* non-critical */ }

            // Auto-run attack simulation using the generated synthetic rows
            try {
                if (result.samples && result.samples.length > 0) {
                    panel.webview.postMessage({ text: '⚔️ Running attack simulation…' });
                    // Write synthetic samples to a temp CSV for the attack simulator
                    const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                    const cols = Object.keys(result.samples[0]);
                    const csvLines = [
                        cols.join(','),
                        ...result.samples.map((row) =>
                            cols.map(c => {
                                const v = row[c] ?? '';
                                const s = String(v);
                                return s.includes(',') || s.includes('"') || s.includes('\n')
                                    ? '"' + s.replace(/"/g, '""') + '"'
                                    : s;
                            }).join(',')
                        )
                    ].join('\n');
                    fs.writeFileSync(synthCsvPath, csvLines);
                    try {
                        attackReport = await runAttackSim(context, filePath, synthCsvPath);
                    } finally {
                        try { fs.unlinkSync(synthCsvPath); } catch { }
                    }
                }
            } catch { /* non-critical */ }

            try {
                panel.webview.postMessage({ text: '🕸️ Building knowledge graph…' });
                knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
            } catch { /* non-critical */ }

            try {
                panel.webview.postMessage({ text: '📊 Tracking lineage…' });
                lineageData = await runLineageBuilder(context, filePath, tmpPath);
            } catch { /* non-critical */ }


            // Update global pipeline context for LLM
            lastPipelineContext = {
                baseline: baselineForPayload,
                leakage: leakageResult ?? undefined,
                result,
                ast: astForPayload,
                scanReport: scanReport ?? undefined,
                attackReport: attackReport ?? undefined,
                graph: knowledgeGraph ?? undefined,
                lineage: lineageData ?? undefined,
            };
            // Store per-panel session state (unified key = panel.id)
            sessionState.set((panel as any).id || panel.viewType || 'default', { filePath, baseline: baselineForPayload });
            lastAst = astForPayload;

            // Generate dataset card in workspace
            try {
                const wsDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const cardDir = path.join(wsDir, '.idelense');
                fs.mkdirSync(cardDir, { recursive: true });
                const cardPath = path.join(cardDir, 'dataset_card.md');
                const leakTmp = path.join(os.tmpdir(), `idelense_leak_${Date.now()}.json`);
                fs.writeFileSync(leakTmp, JSON.stringify(leakageResult));
                await runDocGenerator(context, tmpPath, leakTmp, undefined, undefined, cardPath);
                try { fs.unlinkSync(leakTmp); } catch { }
            } catch { /* non-critical */ }

            // If a dashboard is already open, update it in-place. Otherwise open a new one.
            const existingPanels: Set<vscode.WebviewPanel> = ((global as Record<string, unknown>).__automatePanels as Set<vscode.WebviewPanel> | undefined) ?? new Set();
            if (existingPanels.size > 0) {
                const existingPanel = existingPanels.values().next().value as vscode.WebviewPanel;
                existingPanel.reveal(vscode.ViewColumn.Beside, true);
                const chartUri = existingPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')
                ).toString();
                const payload = {
                    type: 'pipelineComplete',
                    data: {
                        mode: 'system',
                        result, leakage: leakageResult ?? null,
                        generate: result,
                        analysis: analysisBlock,
                        ast: astForPayload ?? null, baseline: baselineForPayload ?? null,
                        scanReport: scanReport ?? null, attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null, lineage: lineageData ?? null,
                        chartUri,
                        trust: analysisTrust,
                        decision: analysisDecision,
                        interpretation: analysisInterpretation,
                        summary: generatedSummary,
                    }
                };
                // Small delay to ensure the panel is revealed and its webview is active
                setTimeout(() => {
                    existingPanel.webview.postMessage(payload);
                    // Also emit normalised pipelineResult so monitorPanel gets spec-compliant fields
                    existingPanel.webview.postMessage({
                        type: 'pipelineResult',
                        mode: 'system',
                        profile: baselineForPayload ?? null,
                        generator: result,
                        generate: result,
                        analysis: analysisBlock,
                        leakage: leakageResult ?? null,
                        intelligence: {},
                        scanReport: scanReport ?? null,
                        ast: astForPayload ?? null,
                        attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null,
                        lineage: lineageData ?? null,
                        trust: analysisTrust,
                        decision: analysisDecision,
                        interpretation: analysisInterpretation,
                        summary: generatedSummary,
                        data: {
                            mode: 'system',
                            profile: baselineForPayload ?? null,
                            baseline: baselineForPayload ?? null,
                            generator: result,
                            generate: result,
                            analysis: analysisBlock,
                            result,
                            leakage: leakageResult ?? null,
                            intelligence: {},
                            scanReport: scanReport ?? null,
                            ast: astForPayload ?? null,
                            attackReport: attackReport ?? null,
                            knowledgeGraph: knowledgeGraph ?? null,
                            lineage: lineageData ?? null,
                            trust: analysisTrust,
                            decision: analysisDecision,
                            interpretation: analysisInterpretation,
                            summary: generatedSummary,
                        }
                    });
                    void pushInsightsToPanel(existingPanel);
                }, 300);
            } else {
                showCheckpointMonitor(
                    context, result, leakageResult, astForPayload, baselineForPayload,
                    scanReport ?? undefined, attackReport ?? undefined, knowledgeGraph ?? undefined, lineageData ?? undefined
                );
            }
            panel.webview.postMessage({ text: `✓ Done — ${result.row_count} rows (${result.generator_used})` });
        } catch (err: unknown) {
            panel.webview.postMessage({ text: `⚠ Error: ${err}` });
            vscode.window.showErrorMessage("Generator error: " + err);
        } finally {
            try { fs.unlinkSync(tmpPath); } catch { }
        }
    }, undefined, context.subscriptions);
}

// ─────────────────────────────────────────────────────────────────────────────
// Privacy Dashboard panel
// ─────────────────────────────────────────────────────────────────────────────
function showCheckpointMonitor(
    context: vscode.ExtensionContext,
    result: GeneratorOutput,
    leakageResult?: LeakageResult | null,
    ast?: Record<string, unknown>,
    baseline?: BaselineArtifact,
    scanReport?: ScanReport,
    attackReport?: Record<string, unknown>,
    knowledgeGraph?: Record<string, unknown>,
    lineageData?: Record<string, unknown>
) {
    // Always create a fresh panel — reuse logic is handled at the call site
    const panel = vscode.window.createWebviewPanel(
        'idelenseCheckpoint',
        'AutoMate — Aurora Privacy Dashboard',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
            ],
        }
    );

    const chartUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')
    );

    function readCheckpoint(): CheckpointEntry | null {
        return null;
    }

    // Build the full DashboardData object matching the UI contract
    const dashboardData: DashboardData = {
        result: result,
        leakage: leakageResult ?? null,
        ast: ast ?? null,
        baseline: baseline ?? null,
        cp: readCheckpoint(),
        chartUri: chartUri.toString(),
        checkpoint: readCheckpoint(),  // alias for backward compat
        // Spec-field aliases — keeps D.generator and D.profile populated on first open
        generator: result,              // D.generator holds .samples, .row_count, .generator_used
        profile: baseline ?? null,      // D.profile holds .columns, .meta
        intelligence: {},               // reserved for future intelligence module
        scanReport: scanReport ?? null,
        attackReport: attackReport ?? null,
        knowledgeGraph: knowledgeGraph ?? null,
        lineage: lineageData ?? null,
        pipelineMetrics: result.metrics ?? null,
    };

    panel.webview.html = buildMonitorHtml(dashboardData);
    void pushInsightsToPanel(panel);

    // Register panel for live alert forwarding
    const activePanels: Set<vscode.WebviewPanel> = ((global as Record<string, unknown>).__automatePanels as Set<vscode.WebviewPanel> | undefined) ?? new Set();
    activePanels.add(panel);
    (global as Record<string, unknown>).__automatePanels = activePanels;

    // Seed the panel with any alerts already in the store
    const existingAlerts = getRecentAlerts(50);
    if (existingAlerts.length > 0) {
        setTimeout(() => {
            panel.webview.postMessage({ type: 'liveSecuritySeed', alerts: existingAlerts });
        }, 500);
    }

    panel.onDidDispose(() => {
        activePanels.delete(panel);
    }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (msg: any) => {
        try {
            if (msg.command === 'runGenerator') {
                const n: number = (typeof msg.n === 'number' && msg.n > 0) ? msg.n : 500;
                let tmpPath: string = '';
                try {
                    const _panelKey = (panel as any).id || panel.viewType || 'default';
                    let _session = sessionState.get(_panelKey) || { filePath: '', baseline: null };
                    // Step 1: ensure we have a parsed file
                    if (!_session.filePath || !_session.baseline) {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '📂 Select a dataset file…' });
                        const fileUri = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectMany: false,
                            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
                            title: 'AutoMate: Select dataset to analyse'
                        });
                        if (!fileUri || !fileUri[0]) {
                            panel.webview.postMessage({ type: 'generatorStatus', text: '⚠ No file selected.' });
                            panel.webview.postMessage({ type: 'resetGenBtn' });
                            return;
                        }
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🔍 Parsing dataset…' });
                        const pickedPath = fileUri[0].fsPath;
                        const kind = detectKind(pickedPath);
                        const ast = await runPythonParser(context, pickedPath);
                        const baseline = await runBaseline(context, pickedPath, kind);
                        _session = { filePath: pickedPath, baseline };
                        sessionState.set(_panelKey, _session);
                        lastAst = ast;
                        panel.webview.postMessage({ type: 'generatorStatus', text: '✓ Parsed. Generating…' });
                    }
                    const lastFilePath = _session.filePath;
                    const lastBaseline = _session.baseline;

                    // Step 2: write baseline to tmp and run pipeline
                    tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
                    fs.writeFileSync(tmpPath, JSON.stringify(lastBaseline));

                    panel.webview.postMessage({ type: 'generatorStatus', text: '🌐 Running /full system pipeline…' });
                    const fullResult = await runFullPipelineApi(lastFilePath, n);
                    const result = fullResult.generate;
                    const leakageResult: LeakageResult | null = null;
                    const analysisDecision = fullResult.analysis?.decision ?? null;
                    const analysisTrust = fullResult.analysis?.trust ?? null;
                    const analysisInterpretation = null;
                    const generatedSummary = (result as any)?.summary ?? null;
                    const analysisBlock = {
                        decision: analysisDecision,
                        trust: analysisTrust,
                        interpretation: analysisInterpretation,
                    };
                    const baselineForPayload = (fullResult.baseline ?? lastBaseline) as BaselineArtifact;
                    const astForPayload = (fullResult.parse ?? lastAst ?? {}) as Record<string, unknown>;

                    let scanReport: ScanReport | null = null;
                    let attackReport: Record<string, unknown> | null = null;
                    let knowledgeGraph: Record<string, unknown> | null = null;
                    let lineageData: Record<string, unknown> | null = null;

                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🛡️ Running PII scan…' });
                        scanReport = await runPIIScan(context, lastFilePath);
                    } catch { /* non-critical */ }

                    try {
                        if (result.samples?.length > 0) {
                            panel.webview.postMessage({ type: 'generatorStatus', text: '⚔️ Running attack simulation…' });
                            const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                            const cols = Object.keys(result.samples[0]);
                            const csvLines = [
                                cols.join(','),
                                ...result.samples.map((row) =>
                                    cols.map(c => {
                                        const v = row[c] ?? '';
                                        const s = String(v);
                                        return s.includes(',') || s.includes('"') || s.includes('\n')
                                            ? '"' + s.replace(/"/g, '""') + '"' : s;
                                    }).join(',')
                                )
                            ].join('\n');
                            fs.writeFileSync(synthCsvPath, csvLines);
                            try {
                                attackReport = await runAttackSim(context, lastFilePath, synthCsvPath);
                            } finally {
                                try { fs.unlinkSync(synthCsvPath); } catch { }
                            }
                        }
                    } catch { /* non-critical */ }

                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🕸️ Building knowledge graph…' });
                        knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
                    } catch { /* non-critical */ }

                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '📊 Tracking lineage…' });
                        lineageData = await runLineageBuilder(context, lastFilePath, tmpPath);
                    } catch { /* non-critical */ }

                    // Update global LLM context
                    lastPipelineContext = {
                        baseline: baselineForPayload,
                        leakage: leakageResult ?? undefined,
                        result,
                        ast: astForPayload,
                        scanReport: scanReport ?? undefined,
                        attackReport: attackReport ?? undefined,
                        graph: knowledgeGraph ?? undefined,
                        lineage: lineageData ?? undefined,
                    };

                    // Push all fresh data to the dashboard
                    const chartUri = panel.webview.asWebviewUri(
                        vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')
                    ).toString();
                    panel.webview.postMessage({
                        type: 'pipelineComplete',
                        data: {
                            mode: 'system',
                            result, leakage: leakageResult,
                            generate: result,
                            analysis: analysisBlock,
                            ast: astForPayload, baseline: baselineForPayload,
                            scanReport, attackReport, knowledgeGraph,
                            lineage: lineageData, chartUri,
                            trust: analysisTrust,
                            decision: analysisDecision,
                            interpretation: analysisInterpretation,
                            summary: generatedSummary,
                        }
                    });
                    panel.webview.postMessage({
                        type: 'pipelineResult',
                        mode: 'system',
                        profile: baselineForPayload,
                        generator: result,
                        generate: result,
                        analysis: analysisBlock,
                        leakage: leakageResult,
                        intelligence: {},
                        scanReport,
                        ast: astForPayload,
                        attackReport,
                        knowledgeGraph,
                        lineage: lineageData,
                        trust: analysisTrust,
                        decision: analysisDecision,
                        interpretation: analysisInterpretation,
                        summary: generatedSummary,
                        data: {
                            mode: 'system',
                            profile: baselineForPayload,
                            baseline: baselineForPayload,
                            generator: result,
                            generate: result,
                            analysis: analysisBlock,
                            result,
                            leakage: leakageResult,
                            intelligence: {},
                            scanReport,
                            ast: astForPayload,
                            attackReport, knowledgeGraph,
                            lineage: lineageData,
                            trust: analysisTrust,
                            decision: analysisDecision,
                            interpretation: analysisInterpretation,
                            summary: generatedSummary,
                        }
                    });
                    void pushInsightsToPanel(panel);
                    panel.webview.postMessage({
                        type: 'generatorStatus',
                        text: `✓ Done — ${result.row_count} rows (${result.generator_used})`
                    });
                } catch (err: unknown) {
                    const msg_ = String(err);
                    panel.webview.postMessage({ type: 'pipelineError', message: msg_ });
                    panel.webview.postMessage({ type: 'resetGenBtn' });
                    vscode.window.showErrorMessage('AutoMate generator error: ' + msg_);
                } finally {
                    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { } }
                }
            }
            if (msg.command === 'cancelGeneration') {
                cancelGeneration();
            }
            if (msg.command === 'exportCSV') {
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, typeof msg.filename === 'string' ? msg.filename : 'synthetic_data.csv');
                fs.writeFileSync(outPath, typeof msg.csv === 'string' ? msg.csv : '');
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') { vscode.window.showTextDocument(vscode.Uri.file(outPath)); }
            }
            if (msg.command === 'exportReport') {
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, typeof msg.filename === 'string' ? msg.filename : 'leakage_report.json');
                fs.writeFileSync(outPath, JSON.stringify(msg.report, null, 2));
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') { vscode.window.showTextDocument(vscode.Uri.file(outPath)); }
            }
            if (msg.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(typeof msg.text === 'string' ? msg.text : '');
            }
            // ── NEW: LLM chat from dashboard ────────────────────────────────
            if (msg.command === 'askAI') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'aiResponse', error: 'OpenRouter API key not configured. Set automate.openrouterApiKey in settings.' });
                    return;
                }
                try {
                    const response = await llmClient.askAboutData(typeof msg.question === 'string' ? msg.question : '', lastPipelineContext);
                    panel.webview.postMessage({ type: 'aiResponse', content: response.content, model: response.model, error: response.error });
                } catch (err: unknown) {
                    panel.webview.postMessage({ type: 'aiResponse', error: (err instanceof Error ? err.message : String(err)) });
                }
            }
            // ── API key status check (called when AI Insights tab opens) ─────
            if (msg.command === 'checkApiKey') {
                const configured = llmClient.isConfigured();
                const providerLabels: Record<string, string> = {
                    openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic',
                    groq: 'Groq', together: 'Together AI', mistral: 'Mistral',
                };
                const providerName = providerLabels[llmClient.getProvider()] || llmClient.getProvider();
                panel.webview.postMessage({ type: 'apiKeyStatus', configured, model: configured ? providerName : null });
                return;
            }
            // ── Phase 4: Store API key from webview (localStorage → extension) ─
            if (msg.command === 'setApiKey') {
                const key: string = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';
                const provider: string = typeof msg.provider === 'string' ? msg.provider.trim() : 'openrouter';
                if (key && key !== 'PASTE_API_KEY_HERE') {
                    // Persist to workspaceState (store per-provider)
                    await context.workspaceState.update(`automate.apiKey.${provider}`, key);
                    // Also update legacy key for openrouter
                    if (provider === 'openrouter') {
                        await context.workspaceState.update('automate.openrouterApiKey', key);
                    }
                    // Inject into live client with provider info
                    llmClient.setKey(key, provider as import('./ai/openrouter_client').AIProvider);
                    const providerLabels: Record<string, string> = {
                        openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic',
                        groq: 'Groq', together: 'Together AI', mistral: 'Mistral',
                    };
                    panel.webview.postMessage({ type: 'apiKeyStatus', configured: true, model: providerLabels[provider] || provider });
                }
                return;
            }
            // ── Open VS Code settings to a specific key ───────────────────────
            if (msg.command === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', msg.key || 'automate.openrouterApiKey');
                return;
            }
            // ── Anonymize Dataset (triggered from webview Anonymize button) ──
            if (msg.command === 'anonymizeDataset') {
                vscode.commands.executeCommand('automate.anonymizeDataset');
                return;
            }
            // ── Clear API key ─────────────────────────────────────────────────
            if (msg.command === 'clearApiKey') {
                await context.workspaceState.update('automate.openrouterApiKey', '');
                llmClient.setKey('');
                const internalClient = llmClient as unknown as { _keySetDirectly?: boolean; apiKey?: string };
                internalClient._keySetDirectly = false;
                internalClient.apiKey = '';
                panel.webview.postMessage({ type: 'apiKeyStatus', configured: false, model: null });
                return;
            }
            // ── Phase 5: Agent Chat (multi-turn with conversation history) ───
            if (msg.command === 'agentChat') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'OpenRouter API key not configured. Set automate.openrouterApiKey in settings.', msgId: msg.msgId });
                    return;
                }
                try {
                    const history = Array.isArray(msg.history) ? msg.history : [];
                    const message = typeof msg.message === 'string' ? msg.message : '';
                    const response = await llmClient.agentChat(
                        history,
                        message,
                        lastPipelineContext
                    );
                    panel.webview.postMessage({ type: 'agentResponse', content: response.content, model: response.model, error: response.error, msgId: msg.msgId });
                } catch (err: unknown) {
                    panel.webview.postMessage({ type: 'agentResponse', error: (err instanceof Error ? err.message : String(err)), msgId: msg.msgId });
                }
            }
            // ── Phase 5: Agent quick-action commands from dashboard ──────────
            if (msg.command === 'agentAction') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'OpenRouter API key not configured.', msgId: msg.msgId });
                    return;
                }
                try {
                    let response: LLMResponse | undefined;
                    switch (msg.action) {
                        case 'explainDataset': response = await llmClient.explainDataset(lastPipelineContext); break;
                        case 'detectAnomalies': response = await llmClient.detectAnomalies(lastPipelineContext); break;
                        case 'suggestCleaning': response = await llmClient.suggestCleaning(lastPipelineContext); break;
                        case 'generateSQL': response = await llmClient.generateSQL(typeof msg.sqlQuestion === 'string' ? msg.sqlQuestion : 'Show all records', lastPipelineContext); break;
                        case 'recommendGovernance': response = await llmClient.recommendGovernance(lastPipelineContext); break;
                        default: response = await llmClient.askAboutData(typeof msg.action === 'string' ? msg.action : '', lastPipelineContext);
                    }
                    panel.webview.postMessage({
                        type: 'agentResponse',
                        content: response?.content ?? '',
                        model: response?.model,
                        error: response?.error,
                        msgId: msg.msgId,
                    });
                } catch (err: unknown) {
                    panel.webview.postMessage({ type: 'agentResponse', error: (err instanceof Error ? err.message : String(err)), msgId: msg.msgId });
                }
            }
        } catch (err) {
            log.error('Webview message handler error', { error: err instanceof Error ? err.message : String(err) });
            try {
                const msg_ = String(err);
                panel.webview.postMessage({ type: 'pipelineError', message: msg_ });
                panel.webview.postMessage({ type: 'resetGenBtn' });
            } catch { /* panel may be disposed */ }
        }
    }, undefined, context.subscriptions);

    // Incremental checkpoint updates — only push delta, no full re-render
    const timer = setInterval(() => {
        const cp = readCheckpoint();
        if (!cp) { return; }
        panel.webview.postMessage({ type: 'checkpointUpdate', data: cp });
        const cpStatus = (cp as unknown as { status?: string }).status;
        if (cpStatus && cpStatus !== 'in_progress') { clearInterval(timer); }
    }, 2000);

    panel.onDidDispose(() => clearInterval(timer), null, context.subscriptions);
}
