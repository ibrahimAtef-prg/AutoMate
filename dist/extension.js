/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const cp = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(3));
const fs = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(5));
const monitorPanel_1 = __webpack_require__(6);
const realtime_scanner_1 = __webpack_require__(13);
const prompt_scanner_1 = __webpack_require__(16);
const openrouter_client_1 = __webpack_require__(17);
const alert_store_1 = __webpack_require__(14);
/*
  AutoMate Aurora — Privacy Dashboard Extension
  Pipeline: parse.py → baseline.py → generator.py → leakage_bridge.py
  Dashboard: src/webview/monitorPanel.ts
*/
// ─────────────────────────────────────────────────────────────────────────────
// Python resolver
// ─────────────────────────────────────────────────────────────────────────────
function resolvePythonCommand() {
    const config = vscode.workspace.getConfiguration('idelense');
    const userPath = config.get('pythonPath');
    if (userPath && userPath.trim()) {
        return userPath.trim();
    }
    if (process.platform === 'win32') {
        return 'py';
    }
    if (process.platform === 'darwin') {
        return 'python3';
    }
    return 'python3';
}
function getPipelineDir() {
    const config = vscode.workspace.getConfiguration('idelense');
    return config.get('pipelinePath') ?? '';
}
// ─────────────────────────────────────────────────────────────────────────────
// Extension activation
// ─────────────────────────────────────────────────────────────────────────────
// ── Global LLM client (shared across commands) ──────────────────────────────
let llmClient;
function activate(context) {
    llmClient = new openrouter_client_1.OpenRouterClient();
    // Restore any key previously saved via the webview API key input
    const savedKey = context.workspaceState.get('automate.openrouterApiKey', '');
    if (savedKey && savedKey !== 'PASTE_API_KEY_HERE') {
        llmClient.setKey(savedKey);
        console.log('[AutoMate] API key restored from workspaceState');
    }
    const provider = new DataImportCodeLensProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider));
    // ── Real-time security scanner ───────────────────────────────────────
    (0, realtime_scanner_1.activateRealtimeScanner)(context);
    // ── Live alert forwarding to open dashboard panels ───────────────────
    // Panels register themselves here when they open (see showCheckpointMonitor)
    const _activePanels = new Set();
    global.__automatePanels = _activePanels;
    const unsubAlert = (0, alert_store_1.onAlert)((alert) => {
        _activePanels.forEach(p => {
            try {
                p.webview.postMessage({ type: 'liveSecurityAlert', alert });
            }
            catch { /* panel disposed */ }
        });
    });
    // ── Existing: Parse Dataset command ──────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("idelense.parseDataset", async (lineText) => {
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
        }
        catch (err) {
            vscode.window.showErrorMessage("Parser Error: " + err);
        }
    }));
    // ── Existing: Generate Synthetic ─────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('idelense.generateSynthetic', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('IDE Lense: Open a Python file that imports a dataset first.');
            return;
        }
        vscode.window.showInformationMessage('IDE Lense: Click the "Parse Dataset (IDE Lense)" lens above your dataset import line.');
    }));
    // ── NEW: Scan Dataset for PII ────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.scanDataset', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select dataset to scan for PII'
        });
        if (!fileUri || !fileUri[0]) {
            return;
        }
        const filePath = fileUri[0].fsPath;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AutoMate: Scanning for PII & secrets…',
            cancellable: false
        }, async () => {
            try {
                const report = await runPIIScan(context, filePath);
                showScanReport(context, report, filePath);
            }
            catch (err) {
                vscode.window.showErrorMessage('Scan failed: ' + err);
            }
        });
    }));
    // ── NEW: Anonymize Dataset ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.anonymizeDataset', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx'] },
            title: 'Select dataset to anonymize'
        });
        if (!fileUri || !fileUri[0]) {
            return;
        }
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
                vscode.window.showInformationMessage(`Anonymized: ${result.cells_anonymized} cells in ${result.anonymized_columns?.length || 0} columns. Saved to ${outputPath}`);
            }
            catch (err) {
                vscode.window.showErrorMessage('Anonymization failed: ' + err);
            }
        });
    }));
    // ── NEW: Run Attack Simulation ───────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.runAttackSimulation', async () => {
        const origUri = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select ORIGINAL dataset'
        });
        if (!origUri?.[0]) {
            return;
        }
        const synthUri = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectMany: false,
            filters: { 'Datasets': ['csv', 'json', 'xlsx', 'parquet'] },
            title: 'Select SYNTHETIC dataset'
        });
        if (!synthUri?.[0]) {
            return;
        }
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AutoMate: Running attack simulations…',
            cancellable: false
        }, async () => {
            try {
                const report = await runAttackSim(context, origUri[0].fsPath, synthUri[0].fsPath);
                showAttackReport(context, report);
            }
            catch (err) {
                vscode.window.showErrorMessage('Attack simulation failed: ' + err);
            }
        });
    }));
    // ── NEW: Generate Dataset Card ───────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.generateDatasetCard', async () => {
        vscode.window.showInformationMessage('AutoMate: Dataset cards are auto-generated when you run the full pipeline from Parse Dataset.');
    }));
    // ── NEW: Scan Prompt for Leakage ─────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.scanPrompt', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Select text first.');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        const textToScan = selection || editor.document.getText();
        const result = (0, prompt_scanner_1.scanPrompt)(textToScan);
        if (result.isClean) {
            vscode.window.showInformationMessage('✅ Prompt is clean — no sensitive data detected.');
        }
        else {
            const action = await vscode.window.showWarningMessage(`⚠ ${result.summary}`, 'Show Anonymized Version', 'Dismiss');
            if (action === 'Show Anonymized Version') {
                const doc = await vscode.workspace.openTextDocument({ content: result.anonymizedPrompt, language: 'text' });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
        }
    }));
    // ── NEW: Ask AI about Data ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.askAI', async () => {
        if (!llmClient.isConfigured()) {
            const action = await vscode.window.showWarningMessage('AutoMate AI requires an OpenRouter API key (free tier). Set "automate.openrouterApiKey" in settings.', 'Open Settings');
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'automate.openrouterApiKey');
            }
            return;
        }
        const question = await vscode.window.showInputBox({
            prompt: 'Ask the AI about your dataset, privacy analysis, or synthetic data…',
            placeHolder: 'e.g., What are the top privacy risks in this dataset?'
        });
        if (!question) {
            return;
        }
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AutoMate AI is thinking…',
            cancellable: false
        }, async () => {
            const response = await llmClient.askAboutData(question, lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
            }
            else {
                const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
        });
    }));
    // ── Phase 5: Agent Commands ───────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('automate.explainDataset', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('AutoMate AI requires an OpenRouter API key. Set "automate.openrouterApiKey" in settings.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Explaining dataset…', cancellable: false }, async () => {
            const response = await llmClient.explainDataset(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.detectAnomalies', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Detecting anomalies…', cancellable: false }, async () => {
            const response = await llmClient.detectAnomalies(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.suggestCleaning', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Generating cleaning suggestions…', cancellable: false }, async () => {
            const response = await llmClient.suggestCleaning(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.generateSQL', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        const question = await vscode.window.showInputBox({
            prompt: 'Describe the SQL query you need (e.g., "Find users with income > 100k")',
            placeHolder: 'e.g., Find all records where age > 18 and email is not null'
        });
        if (!question) {
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Generating SQL…', cancellable: false }, async () => {
            const response = await llmClient.generateSQL(question, lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'sql' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('automate.recommendGovernance', async () => {
        if (!llmClient.isConfigured()) {
            vscode.window.showWarningMessage('OpenRouter API key required.');
            return;
        }
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoMate: Building governance plan…', cancellable: false }, async () => {
            const response = await llmClient.recommendGovernance(lastPipelineContext);
            if (response.error) {
                vscode.window.showErrorMessage('AI Error: ' + response.error);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: response.content, language: 'markdown' });
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
    }));
    // ── Open Aurora Dashboard directly (standalone, without prior generate) ─
    context.subscriptions.push(vscode.commands.registerCommand('automate.openDashboard', () => {
        const chartUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js');
        const emptyData = {
            result: null, leakage: null, ast: null, baseline: null,
            cp: null, checkpoint: null,
            chartUri: '', scanReport: null, attackReport: null,
            knowledgeGraph: null, lineage: null,
        };
        showCheckpointMonitor(context, { checkpoint_path: '', generator_used: '', row_count: 0, samples: [] }, null, null, null, null, null, null, null);
    }));
}
function deactivate() {
    (0, realtime_scanner_1.deactivateRealtimeScanner)();
}
// ─────────────────────────────────────────────────────────────────────────────
// CodeLens provider
// ─────────────────────────────────────────────────────────────────────────────
class DataImportCodeLensProvider {
    provideCodeLenses(document) {
        const ranges = detectDataImports(document);
        return ranges.map(range => new vscode.CodeLens(range, {
            title: "Parse Dataset (IDE Lense)",
            command: "idelense.parseDataset",
            arguments: [document.lineAt(range.start.line).text]
        }));
    }
}
function detectDataImports(document) {
    const regex = /(read_csv|read_excel|read_json|read_parquet|spark\.read)/g;
    const ranges = [];
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (regex.test(line.text)) {
            ranges.push(line.range);
        }
        regex.lastIndex = 0;
    }
    return ranges;
}
function extractPathFromImport(line) {
    const match = line.match(/['"]([^'"]+\.(csv|xlsx|json|parquet))['"]/);
    return match ? match[1] : null;
}
function detectKind(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".csv") {
        return "csv";
    }
    if (ext === ".xlsx") {
        return "excel";
    }
    if (ext === ".json") {
        return "json";
    }
    if (ext === ".parquet") {
        return "parquet";
    }
    return "csv";
}
// ─────────────────────────────────────────────────────────────────────────────
// Python process helpers
// ─────────────────────────────────────────────────────────────────────────────
function spawnPython(py, args, extraEnv) {
    return cp.spawn(py, args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1", ...(extraEnv ?? {}) },
    });
}
function collectOutput(proc) {
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => stdout += d.toString());
        proc.stderr.on("data", (d) => stderr += d.toString());
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
}
function runPythonParser(context, filePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "parse.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) {
            reject(stderr || `parse.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from parse.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject("Invalid JSON from parse.py");
        }
    });
}
function runBaseline(context, filePath, kind) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "baseline.py");
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath, "--kind", kind]));
        if (code !== 0) {
            reject(stderr || `baseline.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from baseline.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject("Invalid JSON from baseline.py");
        }
    });
}
function runGenerator(context, filePath, baselinePath, n) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir = path.join(workspaceDir, '.idelense', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, filePath, baselinePath, "--n", String(n), "--cache-dir", cacheDir
        ]));
        if (code !== 0) {
            reject(stderr || `generator.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from generator.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject("Invalid JSON from generator.py");
        }
    });
}
/**
 * runLeakageAnalysis — always resolves (never rejects).
 * Returns the full LeakageResult contract with all required fields.
 */
function runLeakageAnalysis(context, originalFilePath, generatorResult) {
    return new Promise(async (resolve) => {
        const errorResult = (msg) => ({
            risk_level: null,
            privacy_score: null,
            privacy_score_reliable: false,
            statistical_drift: null,
            duplicates_rate: null,
            membership_inference_auc: null,
            top_threats: [],
            threat_details: [],
            column_drift: {},
            has_uncertainty: true,
            uncertainty_notes: [msg],
            error: msg,
            _mode: "error",
            privacy_components: { duplicates_risk: 0, mi_attack_risk: 0, distance_similarity_risk: 0, distribution_drift_risk: 0 },
        });
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, "src", "utils", "leakage_bridge.py");
        const n = generatorResult?.row_count ?? 500;
        const pipelineDir = getPipelineDir();
        const args = [scriptPath, "--original", originalFilePath, "--n", String(n)];
        if (pipelineDir) {
            args.push("--pipeline-dir", pipelineDir);
        }
        let proc;
        try {
            proc = spawnPython(py, args);
        }
        catch (spawnErr) {
            resolve(errorResult(`Could not start leakage_bridge.py: ${spawnErr.message}`));
            return;
        }
        const { stdout, stderr } = await collectOutput(proc);
        const trimmed = stdout.trim();
        if (trimmed) {
            try {
                const parsed = JSON.parse(trimmed);
                // Ensure privacy_components always exists
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
                resolve(parsed);
                return;
            }
            catch {
                resolve(errorResult(`Invalid JSON from leakage_bridge.py: ${trimmed.slice(0, 120)}`));
                return;
            }
        }
        resolve(errorResult(stderr.trim() || "leakage_bridge.py exited with no output"));
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Pipeline context for LLM (updated after each full run)
// ─────────────────────────────────────────────────────────────────────────────
let lastPipelineContext = {};
// ─────────────────────────────────────────────────────────────────────────────
// Last parsed file state — enables dashboard "Run Generator" to re-run pipeline
// ─────────────────────────────────────────────────────────────────────────────
let lastFilePath = '';
let lastBaseline = null;
let lastAst = null;
// ─────────────────────────────────────────────────────────────────────────────
// New Python process runners
// ─────────────────────────────────────────────────────────────────────────────
function runPIIScan(context, filePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'data_scanner.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [scriptPath, filePath]));
        if (code !== 0) {
            reject(stderr || `data_scanner.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from data_scanner.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from data_scanner.py');
        }
    });
}
function runAnonymizer(context, filePath, outputPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'security', 'anonymizer.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, filePath, '--output', outputPath
        ]));
        if (code !== 0) {
            reject(stderr || `anonymizer.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from anonymizer.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from anonymizer.py');
        }
    });
}
function runAttackSim(context, originalPath, syntheticPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'privacy', 'attack_simulator.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--original', originalPath, '--synthetic', syntheticPath
        ]));
        if (code !== 0) {
            reject(stderr || `attack_simulator.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from attack_simulator.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from attack_simulator.py');
        }
    });
}
function runKnowledgeGraph(context, baselinePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'knowledge_graph.py');
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, [
            scriptPath, '--baseline', baselinePath
        ]));
        if (code !== 0) {
            reject(stderr || `knowledge_graph.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from knowledge_graph.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from knowledge_graph.py');
        }
    });
}
function runDocGenerator(context, baselinePath, leakagePath, scanPath, attackPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'doc_generator.py');
        const args = [scriptPath, '--baseline', baselinePath];
        if (leakagePath) {
            args.push('--leakage', leakagePath);
        }
        if (scanPath) {
            args.push('--scan', scanPath);
        }
        if (attackPath) {
            args.push('--attack', attackPath);
        }
        if (outputPath) {
            args.push('--output', outputPath);
        }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) {
            reject(stderr || `doc_generator.py exited ${code}`);
            return;
        }
        resolve(stdout);
    });
}
function runLineageBuilder(context, sourcePath, baselinePath, leakagePath) {
    return new Promise(async (resolve, reject) => {
        const py = resolvePythonCommand();
        const scriptPath = path.join(context.extensionPath, 'src', 'ai', 'lineage.py');
        const args = [scriptPath, '--source', sourcePath];
        if (baselinePath) {
            args.push('--baseline', baselinePath);
        }
        if (leakagePath) {
            args.push('--leakage', leakagePath);
        }
        const { stdout, stderr, code } = await collectOutput(spawnPython(py, args));
        if (code !== 0) {
            reject(stderr || `lineage.py exited ${code}`);
            return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            reject('Empty output from lineage.py');
            return;
        }
        try {
            resolve(JSON.parse(trimmed));
        }
        catch {
            reject('Invalid JSON from lineage.py');
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Show PII scan report in a new panel
// ─────────────────────────────────────────────────────────────────────────────
function showScanReport(context, report, filePath) {
    const panel = vscode.window.createWebviewPanel('automateScanReport', 'AutoMate — PII Scan Report', vscode.ViewColumn.Beside, { enableScripts: true });
    const n_pii = report.pii_findings?.length || 0;
    const n_sec = report.secrets?.length || 0;
    const n_sen = report.sensitive_content?.length || 0;
    const riskColor = report.risk_score > 70 ? '#ef4444' : report.risk_score > 30 ? '#f59e0b' : '#10b981';
    const findingsHtml = [...(report.pii_findings || []), ...(report.secrets || []), ...(report.sensitive_content || [])]
        .slice(0, 50)
        .map((f) => `<tr><td>${esc(f.type)}</td><td>${esc(f.category)}</td><td>${esc(f.column)}</td><td>${esc(f.severity)}</td><td>${esc(f.value_preview || '—')}</td></tr>`)
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
<div class="stat-box"><label>Cells Scanned</label><span style="color:#c084fc">${report.total_cells_scanned?.toLocaleString() || '—'}</span></div>
<div class="stat-box"><label>Columns</label><span style="color:#c084fc">${report.columns_scanned || '—'}</span></div>
</div></div>
${report.high_risk_columns?.length ? `<div class="card"><h2>⚠ High-Risk Columns</h2><p style="font-size:12px;color:#f59e0b">${report.high_risk_columns.join(', ')}</p></div>` : ''}
<div class="card"><h2>📋 Findings (top 50)</h2>
<table><thead><tr><th>Type</th><th>Category</th><th>Column</th><th>Severity</th><th>Preview</th></tr></thead>
<tbody>${findingsHtml || '<tr><td colspan="5" style="text-align:center;padding:12px;color:#9080b0">✅ No findings — dataset appears clean.</td></tr>'}</tbody></table>
</div>
<div class="card" style="font-size:11px;color:#9080b0">${esc(report.summary || '')}</div>
</body></html>`;
}
// Show attack simulation report
function showAttackReport(context, report) {
    const panel = vscode.window.createWebviewPanel('automateAttackReport', 'AutoMate — Attack Simulation', vscode.ViewColumn.Beside, { enableScripts: true });
    const vulnColor = report.overall_vulnerability === 'safe' ? '#10b981' :
        report.overall_vulnerability === 'moderate' ? '#f59e0b' : '#ef4444';
    const resultsHtml = (report.results || []).map((r) => {
        const icon = r.success ? '❌' : '✅';
        const sevColor = r.severity === 'critical' ? '#ef4444' : r.severity === 'high' ? '#f59e0b' : '#10b981';
        return `<div style="background:#1a1a2e;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${sevColor}">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-weight:600;color:#ede5f8">${icon} ${esc(r.attack_name)}</span>
                <span style="font-size:10px;color:${sevColor};text-transform:uppercase">${esc(r.severity)}</span>
            </div>
            <p style="font-size:11px;color:#9080b0;margin-top:4px">${esc(r.description)}</p>
            <p style="font-size:10px;color:#7c6fa0;margin-top:2px">Success rate: ${(r.success_rate * 100).toFixed(1)}%</p>
        </div>`;
    }).join('');
    const recsHtml = (report.recommendations || []).map((r) => `<li style="font-size:11px;color:#9080b0;margin-bottom:4px">💡 ${esc(r)}</li>`).join('');
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:var(--vscode-font-family,sans-serif);color:#ede5f8;background:#0f0f17;padding:20px}
.card{background:#171723;border:1px solid #2a2a3b;border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:15px;margin-bottom:12px;font-weight:600;color:#c084fc}
</style></head><body>
<div class="card"><h2>⚔️ Attack Simulation Report</h2>
<p style="font-size:12px;margin-bottom:8px">Vulnerability: <span style="color:${vulnColor};font-weight:700;text-transform:uppercase">${esc(report.overall_vulnerability)}</span></p>
<p style="font-size:11px;color:#9080b0">${esc(report.summary)}</p></div>
<div class="card"><h2>Results</h2>${resultsHtml}</div>
${recsHtml ? `<div class="card"><h2>💡 Recommendations</h2><ul style="padding-left:16px">${recsHtml}</ul></div>` : ''}
</body></html>`;
}
// Simple HTML escape helper for report panels
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ─────────────────────────────────────────────────────────────────────────────
// Parse + Baseline panel (before generation)
// ─────────────────────────────────────────────────────────────────────────────
function showCombinedResult(context, ast, baseline, filePath) {
    const panel = vscode.window.createWebviewPanel("idelenseCombined", "IDE Lense — Parse + Baseline", vscode.ViewColumn.Beside, { enableScripts: true });
    const astDs = ast?.dataset ?? ast ?? {};
    const schemaFields = astDs?.schema?.fields ?? [];
    const profile = astDs?.profile ?? {};
    const blNumCols = Object.keys(baseline?.columns?.numeric ?? {});
    const blCatCols = Object.keys(baseline?.columns?.categorical ?? {});
    const colRows = schemaFields.map((f) => {
        const isNum = blNumCols.includes(f.name);
        const isCat = blCatCols.includes(f.name);
        const tag = isNum ? 'numeric' : isCat ? 'categorical' : f.dtype ?? '—';
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
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command !== "generate") {
            return;
        }
        const tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(baseline));
        try {
            const result = await runGenerator(context, filePath, tmpPath, msg.n);
            panel.webview.postMessage({ text: '🔍 Running leakage analysis…' });
            const leakageResult = await runLeakageAnalysis(context, filePath, result);
            // ── Run extended analytics pipeline ──────────────────────────
            let scanReport = null;
            let attackReport = null;
            let knowledgeGraph = null;
            let lineageData = null;
            try {
                panel.webview.postMessage({ text: '🛡️ Running PII scan…' });
                scanReport = await runPIIScan(context, filePath);
            }
            catch { /* non-critical */ }
            // Auto-run attack simulation using the generated synthetic rows
            try {
                if (result.samples && result.samples.length > 0) {
                    panel.webview.postMessage({ text: '⚔️ Running attack simulation…' });
                    // Write synthetic samples to a temp CSV for the attack simulator
                    const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                    const cols = Object.keys(result.samples[0]);
                    const csvLines = [
                        cols.join(','),
                        ...result.samples.map((row) => cols.map(c => {
                            const v = row[c] ?? '';
                            const s = String(v);
                            return s.includes(',') || s.includes('"') || s.includes('\n')
                                ? '"' + s.replace(/"/g, '""') + '"'
                                : s;
                        }).join(','))
                    ].join('\n');
                    fs.writeFileSync(synthCsvPath, csvLines);
                    try {
                        attackReport = await runAttackSim(context, filePath, synthCsvPath);
                    }
                    finally {
                        try {
                            fs.unlinkSync(synthCsvPath);
                        }
                        catch { }
                    }
                }
            }
            catch { /* non-critical */ }
            try {
                panel.webview.postMessage({ text: '🕸️ Building knowledge graph…' });
                knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
            }
            catch { /* non-critical */ }
            try {
                panel.webview.postMessage({ text: '📊 Tracking lineage…' });
                lineageData = await runLineageBuilder(context, filePath, tmpPath);
            }
            catch { /* non-critical */ }
            // Update global pipeline context for LLM
            lastPipelineContext = {
                baseline, leakage: leakageResult, result, ast,
                scanReport, attackReport, graph: knowledgeGraph, lineage: lineageData
            };
            // Keep last-file globals in sync so dashboard can re-run
            lastFilePath = filePath;
            lastBaseline = baseline;
            lastAst = ast;
            // Generate dataset card in workspace
            try {
                const wsDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const cardDir = path.join(wsDir, '.idelense');
                fs.mkdirSync(cardDir, { recursive: true });
                const cardPath = path.join(cardDir, 'dataset_card.md');
                const leakTmp = path.join(os.tmpdir(), `idelense_leak_${Date.now()}.json`);
                fs.writeFileSync(leakTmp, JSON.stringify(leakageResult));
                await runDocGenerator(context, tmpPath, leakTmp, undefined, undefined, cardPath);
                try {
                    fs.unlinkSync(leakTmp);
                }
                catch { }
            }
            catch { /* non-critical */ }
            // If a dashboard is already open, update it in-place. Otherwise open a new one.
            const existingPanels = global.__automatePanels ?? new Set();
            if (existingPanels.size > 0) {
                const existingPanel = existingPanels.values().next().value;
                existingPanel.reveal(vscode.ViewColumn.Beside, true);
                const chartUri = existingPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')).toString();
                const payload = {
                    type: 'pipelineComplete',
                    data: {
                        result, leakage: leakageResult ?? null,
                        ast: ast ?? null, baseline: baseline ?? null,
                        scanReport: scanReport ?? null, attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null, lineage: lineageData ?? null,
                        chartUri,
                    }
                };
                // Small delay to ensure the panel is revealed and its webview is active
                setTimeout(() => {
                    existingPanel.webview.postMessage(payload);
                    // Also emit normalised pipelineResult so monitorPanel gets spec-compliant fields
                    existingPanel.webview.postMessage({
                        type: 'pipelineResult',
                        profile: baseline ?? null,
                        generator: result,
                        leakage: leakageResult ?? null,
                        intelligence: {},
                        scanReport: scanReport ?? null,
                        ast: ast ?? null,
                        attackReport: attackReport ?? null,
                        knowledgeGraph: knowledgeGraph ?? null,
                        lineage: lineageData ?? null,
                        data: {
                            profile: baseline ?? null,
                            baseline: baseline ?? null,
                            generator: result,
                            result,
                            leakage: leakageResult ?? null,
                            intelligence: {},
                            scanReport: scanReport ?? null,
                            ast: ast ?? null,
                            attackReport: attackReport ?? null,
                            knowledgeGraph: knowledgeGraph ?? null,
                            lineage: lineageData ?? null,
                        }
                    });
                    console.log('[AutoMate] pipelineResult sent to existing panel — rows:', result?.row_count);
                }, 300);
            }
            else {
                showCheckpointMonitor(context, result, leakageResult, ast, baseline, scanReport, attackReport, knowledgeGraph, lineageData);
            }
            panel.webview.postMessage({ text: `✓ Done — ${result.row_count} rows (${result.generator_used})` });
        }
        catch (err) {
            panel.webview.postMessage({ text: `⚠ Error: ${err}` });
            vscode.window.showErrorMessage("Generator error: " + err);
        }
        finally {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { }
        }
    }, undefined, context.subscriptions);
}
// ─────────────────────────────────────────────────────────────────────────────
// Privacy Dashboard panel
// ─────────────────────────────────────────────────────────────────────────────
function showCheckpointMonitor(context, result, leakageResult, ast, baseline, scanReport, attackReport, knowledgeGraph, lineageData) {
    // Always create a fresh panel — reuse logic is handled at the call site
    const panel = vscode.window.createWebviewPanel('idelenseCheckpoint', 'AutoMate — Aurora Privacy Dashboard', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    });
    const chartUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js'));
    const cpPath = result.checkpoint_path ?? '';
    function readCheckpoint() {
        try {
            return JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    // Build the full DashboardData object matching the UI contract
    const dashboardData = {
        result: result,
        leakage: leakageResult ?? null,
        ast: ast ?? null,
        baseline: baseline ?? null,
        cp: readCheckpoint(),
        chartUri: chartUri.toString(),
        checkpoint: readCheckpoint(), // alias for backward compat
        // Spec-field aliases — keeps D.generator and D.profile populated on first open
        generator: result, // D.generator holds .samples, .row_count, .generator_used
        profile: baseline ?? null, // D.profile holds .columns, .meta
        intelligence: {}, // reserved for future intelligence module
        scanReport: scanReport ?? null,
        attackReport: attackReport ?? null,
        knowledgeGraph: knowledgeGraph ?? null,
        lineage: lineageData ?? null,
    };
    panel.webview.html = (0, monitorPanel_1.buildMonitorHtml)(dashboardData);
    // Register panel for live alert forwarding
    const activePanels = global.__automatePanels ?? new Set();
    activePanels.add(panel);
    global.__automatePanels = activePanels;
    // Seed the panel with any alerts already in the store
    const existingAlerts = (0, alert_store_1.getRecentAlerts)(50);
    if (existingAlerts.length > 0) {
        setTimeout(() => {
            panel.webview.postMessage({ type: 'liveSecuritySeed', alerts: existingAlerts });
        }, 500);
    }
    panel.onDidDispose(() => {
        activePanels.delete(panel);
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            if (msg.command === 'runGenerator') {
                const n = (typeof msg.n === 'number' && msg.n > 0) ? msg.n : 500;
                let tmpPath = '';
                try {
                    // Step 1: ensure we have a parsed file
                    if (!lastFilePath || !lastBaseline) {
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
                        lastFilePath = pickedPath;
                        lastBaseline = baseline;
                        lastAst = ast;
                        panel.webview.postMessage({ type: 'generatorStatus', text: '✓ Parsed. Generating…' });
                    }
                    // Step 2: write baseline to tmp and run pipeline
                    tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
                    fs.writeFileSync(tmpPath, JSON.stringify(lastBaseline));
                    panel.webview.postMessage({ type: 'generatorStatus', text: '⚙️ Generating synthetic data…' });
                    const result = await runGenerator(context, lastFilePath, tmpPath, n);
                    panel.webview.postMessage({ type: 'generatorStatus', text: '🔍 Running leakage analysis…' });
                    const leakageResult = await runLeakageAnalysis(context, lastFilePath, result);
                    let scanReport = null;
                    let attackReport = null;
                    let knowledgeGraph = null;
                    let lineageData = null;
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🛡️ Running PII scan…' });
                        scanReport = await runPIIScan(context, lastFilePath);
                    }
                    catch { /* non-critical */ }
                    try {
                        if (result.samples?.length > 0) {
                            panel.webview.postMessage({ type: 'generatorStatus', text: '⚔️ Running attack simulation…' });
                            const synthCsvPath = path.join(os.tmpdir(), `idelense_synth_${Date.now()}.csv`);
                            const cols = Object.keys(result.samples[0]);
                            const csvLines = [
                                cols.join(','),
                                ...result.samples.map((row) => cols.map(c => {
                                    const v = row[c] ?? '';
                                    const s = String(v);
                                    return s.includes(',') || s.includes('"') || s.includes('\n')
                                        ? '"' + s.replace(/"/g, '""') + '"' : s;
                                }).join(','))
                            ].join('\n');
                            fs.writeFileSync(synthCsvPath, csvLines);
                            try {
                                attackReport = await runAttackSim(context, lastFilePath, synthCsvPath);
                            }
                            finally {
                                try {
                                    fs.unlinkSync(synthCsvPath);
                                }
                                catch { }
                            }
                        }
                    }
                    catch { /* non-critical */ }
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '🕸️ Building knowledge graph…' });
                        knowledgeGraph = await runKnowledgeGraph(context, tmpPath);
                    }
                    catch { /* non-critical */ }
                    try {
                        panel.webview.postMessage({ type: 'generatorStatus', text: '📊 Tracking lineage…' });
                        lineageData = await runLineageBuilder(context, lastFilePath, tmpPath);
                    }
                    catch { /* non-critical */ }
                    // Update global LLM context
                    lastPipelineContext = {
                        baseline: lastBaseline, leakage: leakageResult, result, ast: lastAst,
                        scanReport, attackReport, graph: knowledgeGraph, lineage: lineageData
                    };
                    // Push all fresh data to the dashboard
                    const chartUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.min.js')).toString();
                    panel.webview.postMessage({
                        type: 'pipelineComplete',
                        data: {
                            result, leakage: leakageResult,
                            ast: lastAst, baseline: lastBaseline,
                            scanReport, attackReport, knowledgeGraph,
                            lineage: lineageData, chartUri,
                        }
                    });
                    // Normalised alias with spec-compliant field names for monitorPanel
                    panel.webview.postMessage({
                        type: 'pipelineResult',
                        profile: lastBaseline, // D.profile
                        generator: result, // D.generator (.samples inside)
                        leakage: leakageResult, // D.leakage
                        intelligence: {}, // D.intelligence (reserved for future module)
                        scanReport, // D.scanReport
                        ast: lastAst,
                        attackReport,
                        knowledgeGraph,
                        lineage: lineageData,
                        data: {
                            profile: lastBaseline, // D.profile
                            baseline: lastBaseline, // D.baseline (compat)
                            generator: result, // D.generator (.samples inside)
                            result, // D.result (compat)
                            leakage: leakageResult, // D.leakage
                            intelligence: {}, // D.intelligence (reserved for future module)
                            scanReport, // D.scanReport
                            ast: lastAst,
                            attackReport, knowledgeGraph,
                            lineage: lineageData,
                        }
                    });
                    console.log('[AutoMate] pipelineResult sent — rows:', result?.row_count, 'samples:', result?.samples?.length, 'scan:', !!scanReport, 'leakage:', !!leakageResult);
                    panel.webview.postMessage({
                        type: 'generatorStatus',
                        text: `✓ Done — ${result.row_count} rows (${result.generator_used})`
                    });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'generatorStatus', text: `⚠ Error: ${err}` });
                    panel.webview.postMessage({ type: 'resetGenBtn' });
                    vscode.window.showErrorMessage('AutoMate generator error: ' + err);
                }
                finally {
                    if (tmpPath) {
                        try {
                            fs.unlinkSync(tmpPath);
                        }
                        catch { }
                    }
                }
            }
            if (msg.command === 'exportCSV') {
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, msg.filename ?? 'synthetic_data.csv');
                fs.writeFileSync(outPath, msg.csv ?? '');
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(vscode.Uri.file(outPath));
                }
            }
            if (msg.command === 'exportReport') {
                const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
                const outPath = path.join(dir, msg.filename ?? 'leakage_report.json');
                fs.writeFileSync(outPath, JSON.stringify(msg.report, null, 2));
                const choice = await vscode.window.showInformationMessage(`Saved: ${outPath}`, 'Open in Editor');
                if (choice === 'Open in Editor') {
                    vscode.window.showTextDocument(vscode.Uri.file(outPath));
                }
            }
            if (msg.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(msg.text ?? '');
            }
            // ── NEW: LLM chat from dashboard ────────────────────────────────
            if (msg.command === 'askAI') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'aiResponse', error: 'OpenRouter API key not configured. Set automate.openrouterApiKey in settings.' });
                    return;
                }
                try {
                    const response = await llmClient.askAboutData(msg.question, lastPipelineContext);
                    panel.webview.postMessage({ type: 'aiResponse', content: response.content, model: response.model, error: response.error });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'aiResponse', error: err.message });
                }
            }
            // ── API key status check (called when AI Insights tab opens) ─────
            if (msg.command === 'checkApiKey') {
                const configured = llmClient.isConfigured();
                panel.webview.postMessage({ type: 'apiKeyStatus', configured, model: configured ? 'OpenRouter' : null });
                return;
            }
            // ── Phase 4: Store API key from webview (localStorage → extension) ─
            if (msg.command === 'setApiKey') {
                const key = (msg.apiKey || '').trim();
                if (key && key !== 'PASTE_API_KEY_HERE') {
                    // Persist to workspaceState so it survives VS Code restarts
                    await context.workspaceState.update('automate.openrouterApiKey', key);
                    // Immediately inject into the live LLM client
                    llmClient.setKey(key);
                    console.log('[AutoMate] API key set via webview input');
                    panel.webview.postMessage({ type: 'apiKeyStatus', configured: true, model: 'OpenRouter' });
                }
                return;
            }
            // ── Open VS Code settings to a specific key ───────────────────────
            if (msg.command === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', msg.key || 'automate.openrouterApiKey');
                return;
            }
            // ── Phase 5: Agent Chat (multi-turn with conversation history) ───
            if (msg.command === 'agentChat') {
                console.log('[AutoMate] agentChat request — message:', msg.message?.slice(0, 80), '| hasContext:', !!lastPipelineContext?.leakage);
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'OpenRouter API key not configured. Set automate.openrouterApiKey in settings.', msgId: msg.msgId });
                    return;
                }
                try {
                    const response = await llmClient.agentChat(msg.history ?? [], msg.message, lastPipelineContext);
                    panel.webview.postMessage({ type: 'agentResponse', content: response.content, model: response.model, error: response.error, msgId: msg.msgId });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentResponse', error: err.message, msgId: msg.msgId });
                }
            }
            // ── Phase 5: Agent quick-action commands from dashboard ──────────
            if (msg.command === 'agentAction') {
                if (!llmClient.isConfigured()) {
                    panel.webview.postMessage({ type: 'agentResponse', error: 'OpenRouter API key not configured.', msgId: msg.msgId });
                    return;
                }
                try {
                    let response;
                    switch (msg.action) {
                        case 'explainDataset':
                            response = await llmClient.explainDataset(lastPipelineContext);
                            break;
                        case 'detectAnomalies':
                            response = await llmClient.detectAnomalies(lastPipelineContext);
                            break;
                        case 'suggestCleaning':
                            response = await llmClient.suggestCleaning(lastPipelineContext);
                            break;
                        case 'generateSQL':
                            response = await llmClient.generateSQL(msg.sqlQuestion ?? 'Show all records', lastPipelineContext);
                            break;
                        case 'recommendGovernance':
                            response = await llmClient.recommendGovernance(lastPipelineContext);
                            break;
                        default: response = await llmClient.askAboutData(msg.action, lastPipelineContext);
                    }
                    panel.webview.postMessage({ type: 'agentResponse', content: response.content, model: response.model, error: response.error, msgId: msg.msgId });
                }
                catch (err) {
                    panel.webview.postMessage({ type: 'agentResponse', error: err.message, msgId: msg.msgId });
                }
            }
        }
        catch (err) {
            console.error('Webview message handler error:', err);
            // Report back to webview so the UI never silently freezes
            try {
                panel.webview.postMessage({ type: 'generatorStatus', text: `⚠ Internal error: ${err}` });
                const btn = 'gen-btn';
                panel.webview.postMessage({ type: 'resetGenBtn' });
            }
            catch { /* panel may be disposed */ }
        }
    }, undefined, context.subscriptions);
    // Incremental checkpoint updates — only push delta, no full re-render
    const timer = setInterval(() => {
        const cp = readCheckpoint();
        if (!cp) {
            return;
        }
        panel.webview.postMessage({ type: 'checkpointUpdate', data: cp });
        if (cp.status !== 'in_progress') {
            clearInterval(timer);
        }
    }, 2000);
    panel.onDidDispose(() => clearInterval(timer), null, context.subscriptions);
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 6 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


/**
 * src/webview/monitorPanel.ts — AutoMate Aurora Privacy Dashboard
 *
 * Fixes applied:
 *  - chartRegistry prevents Canvas-already-in-use crash (Chart.js CDN + inline fallback)
 *  - All metrics use REAL backend data (leakage, baseline, result)
 *  - Aurora Purple theme, card-grid layout, hover glows, micro-animations
 *  - Tab navigation: Overview | Schema | Synthetic | Threats | Diagnostics
 *  - Sticky header, status strip with real values
 *  - postMessage-based incremental updates (no full re-render)
 *  - Pipeline Timeline card showing real stage data
 *  - No fake/hash-based calculations
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.buildMonitorHtml = buildMonitorHtml;
const charts_1 = __webpack_require__(7);
const overview_1 = __webpack_require__(8);
const synthetic_1 = __webpack_require__(9);
const security_1 = __webpack_require__(10);
const livesecurity_1 = __webpack_require__(11);
const agent_1 = __webpack_require__(12);
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function buildMonitorHtml(data) {
    const dataJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AutoMate — Aurora Privacy Dashboard</title>
<script src="${esc(data.chartUri)}"></script>
<script>\n${charts_1.CHART_INLINE_FALLBACK_SCRIPT}\n</script>\n<style>\n${charts_1.DASHBOARD_STYLES}\n</style>
</head>
<body>

<!-- Sticky header -->
<div class="hdr">
  <div class="logo">
    <div class="logo-icon">🔬</div>
    <div>
      <div class="logo-title">AutoMate</div>
      <div class="logo-sub" id="hdr-sub">Aurora Privacy Dashboard</div>
    </div>
  </div>
  <div class="hdr-right">
    <button class="hbtn hbtn-g" onclick="doExportCSV()">&#8595; Export CSV</button>
    <button class="hbtn hbtn-g" onclick="vscode.postMessage({command:'automate.anonymizeDataset'})" title="Auto-anonymize PII columns">🛡️ Anonymize</button>
    <button class="hbtn hbtn-p" onclick="doExportReport()">&#128203; Save Report</button>
  </div>
</div>

<!-- Status strip -->
<div class="strip">
  <div class="spill"><div><div class="sl">Risk Level</div><div class="sv" id="m-risk">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Privacy Score</div><div class="sv" id="m-ps">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Drift</div><div class="sv" id="m-drift">&#8212;</div></div></div>

  <div class="spill"><div><div class="sl">Duplicates</div><div class="sv" id="m-dup">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Rows</div><div class="sv" id="m-rows">&#8212;</div></div></div>
</div>

<!-- Sanity warning banner (populated by JS) -->
<div id="sanity-banner" style="display:none"></div>

<!-- Tab navigation -->
<div class="tabs">
  <button class="tab active"  onclick="showTab('overview',this)">Overview</button>
  <button class="tab"     onclick="showTab('synthetic',this)">Synthetic Data</button>
  <button class="tab"     onclick="showTab('security',this)">🛡️ Security</button>
  <button class="tab" id="live-sec-tab" onclick="showTab('livesecurity',this)">🔴 Live Security</button>
  <button class="tab"     onclick="showTab('aiinsights',this)">🤖 AI Insights</button>
</div>

${overview_1.OVERVIEW_TAB_HTML}
${synthetic_1.SYNTHETIC_TAB_HTML}
${security_1.SECURITY_TAB_HTML}
${livesecurity_1.LIVE_SECURITY_TAB_HTML}
${agent_1.AGENT_TAB_HTML}

<script>
const vscode = acquireVsCodeApi();
let D: DashboardState = {
  profile: null,
  generator: null,
  leakage: null,
  scanReport: null,
  intelligence: null,
  result: null,
  baseline: null,
  ast: null,
  attackReport: null,
  knowledgeGraph: null,
  lineage: null,
  cp: null,
};
D = Object.assign(D, ${dataJson} || {});
if(!D.generator && D.result) D.generator = D.result;
if(!D.profile && D.baseline) D.profile = D.baseline;

// ── PART 1: Stable global tab state ─────────────────────────────────
let activeTab = 'overview';

// ── Chart registry ──────────────────────────────────────────────────
const chartRegistry = {};
function getOrCreateChart(id, config) {
  if (chartRegistry[id]) { try{chartRegistry[id].destroy();}catch(e){} }
  const canvas = document.getElementById(id);
  if(!canvas) return null;
  chartRegistry[id] = new Chart(canvas, config);
  return chartRegistry[id];
}
${charts_1.RISK_RADAR_SCRIPT}

// ── Helpers ─────────────────────────────────────────────────────────
function pct(v){ if(v==null)return '—'; return (v*100).toFixed(1)+'%'; }
function pctInt(v){ if(v==null)return 0; return Math.min(100,Math.max(0,Math.round(v*100))); }
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const C={
  p0:'#1e0057',p1:'#4c1d95',p2:'#6d28d9',p3:'#7c3aed',
  p4:'#8b5cf6',p5:'#a78bfa',p6:'#c084fc',p7:'#ddd6fe',
  fg2:'#9b8ec4',fg3:'#524870',card2:'#1e1e2e',card3:'#252538',
  green:'#34d399',red:'#f87171',orange:'#fb923c',yellow:'#fbbf24',
};

function rbadge(risk){
  const r=(risk||'unknown').toLowerCase();
  const cl=r==='critical'?'rc-crit':r==='warning'?'rc-warn':r==='low'?'rc-low':'rc-unk';
  return '<span class="rbadge '+cl+'">'+esc(r.toUpperCase())+'</span>';
}

// ── PART 2: Stable tab switching (uses activeTab global) ────────────
function showTab(name,btn){
  activeTab = name;

  document.querySelectorAll(".tabpane")
  .forEach(p=>p.classList.remove("active"));

  document.querySelectorAll(".tab")
  .forEach(b=>b.classList.remove("active"));

  const pane = document.getElementById("pane-"+name);
  if(pane) pane.classList.add("active");

  if(btn) btn.classList.add("active");

  renderAll();
}

${overview_1.OVERVIEW_SCRIPT}

// ── Schema tab ──────────────────────────────────────────────────────

${synthetic_1.SYNTHETIC_SCRIPT}

// ── Threats tab ──────────────────────────────────────────────────────

// ── Export ───────────────────────────────────────────────────────────
function reqGen(){
  const nEl = document.getElementById('gen-n');
  const btn = document.getElementById('gen-btn');
  const n = parseInt((nEl && nEl.value)||'500', 10) || 500;
  if(btn){ btn.disabled=true; btn.textContent='⏳ Running…'; }
  document.getElementById('gen-status').textContent='Sending request…';
  vscode.postMessage({command:'runGenerator', n});
}
function doExportCSV(){
  var rows=_getSamples();
  if(!rows.length){ return; }
  var cols=Object.keys(rows[0]||{});
  var csv=[cols.join(',')].concat(rows.map(function(r){return cols.map(function(c){var v=r[c]!=null?r[c]:'';return String(v).includes(',')? '"'+String(v).replace(/"/g,'""')+'"':String(v);}).join(',');})).join(String.fromCharCode(10));
  vscode.postMessage({command:'exportCSV',csv:csv,filename:'synthetic_data.csv'});
}
function doExportReport(){
  var r=D.generator||D.result||{};
  var b=D.profile||D.baseline||{};
  vscode.postMessage({command:'exportReport',
    report:{generated_at:new Date().toISOString(),leakage:D.leakage,
      generation:{engine:r.generator_used,row_count:r.row_count},
      schema:{numeric:Object.keys((b.columns&&b.columns.numeric)||{}),categorical:Object.keys((b.columns&&b.columns.categorical)||{})}},
    filename:'leakage_report.json'});
}

// ── Incremental postMessage update ───────────────────────────────────
window.addEventListener('message',function(ev){
  var msg=ev.data;
  if(!msg||!msg.type) return;
  console.log('[AutoMate] message received:', msg.type);

  if(msg.type==='checkpointUpdate'&&msg.data){
    D.cp=msg.data;
    syntheticRendered=false; secRendered=false;
    renderStrip(); renderC1(); renderTimeline();
  }

  if(msg.type==='generatorStatus'){
    var statusEl=document.getElementById('gen-status');
    if(statusEl) statusEl.textContent=msg.text||'';
    if(msg.text&&(msg.text.startsWith('✓')||msg.text.startsWith('⚠'))){
      var btn=document.getElementById('gen-btn');
      if(btn){ btn.disabled=false; btn.textContent='▶ Run Generator'; }
    }
  }

  if(msg.type==='resetGenBtn'){
    var btn2=document.getElementById('gen-btn');
    if(btn2){ btn2.disabled=false; btn2.textContent='▶ Run Generator'; }
  }

  // ── pipelineComplete (legacy): full data bundle ──────────────────────
  if(msg.type==='pipelineComplete'){
    var d0=msg.data||msg;  // accept both {type,data:{}} and flat
    if(d0.result)         D.result=d0.result;
    if(d0.generator)      D.generator=d0.generator;
    if(d0.leakage)        D.leakage=d0.leakage;
    if(d0.ast)            D.ast=d0.ast;
    if(d0.baseline)       D.baseline=d0.baseline;
    if(d0.profile)        D.profile=d0.profile;
    if(d0.scanReport)     D.scanReport=d0.scanReport;
    if(d0.attackReport)   D.attackReport=d0.attackReport;
    if(d0.knowledgeGraph) D.knowledgeGraph=d0.knowledgeGraph;
    if(d0.lineage)        D.lineage=d0.lineage;
    // Mirror: D.generator = D.result if generator wasn't set explicitly
    if(!D.generator&&D.result) D.generator=D.result;
    if(!D.profile&&D.baseline) D.profile=D.baseline;
    console.log('[AutoMate] pipelineComplete — rows:', (D.generator||D.result||{}).row_count,
      'samples:', _getSamples().length, 'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }

  // ── pipelineResult: spec field names from extension ──────────────────
  if(msg.type==='pipelineResult'){
    console.log('[AutoMate] pipelineResult received');
    console.log('[AutoMate] pipelineResult received', msg);
    const d = msg.data || msg;
    
    // Process input data
    if(d.generator){
      D.generator = d.generator;
      D.result = d.generator;
    } else if(d.result){
      D.result = d.result;
      if(!D.generator) D.generator = d.result;
    }

    if(d.profile){
      D.profile = d.profile;
      D.baseline = d.profile;
    } else if(d.baseline){
      D.baseline = d.baseline;
      if(!D.profile) D.profile = d.baseline;
    }

    if(d.leakage) D.leakage = d.leakage;
    if(d.scanReport) D.scanReport = d.scanReport;
    if(d.intelligence!==undefined) D.intelligence = d.intelligence;
    if(d.ast!==undefined) D.ast = d.ast;
    if(d.attackReport!==undefined) D.attackReport = d.attackReport;
    if(d.knowledgeGraph!==undefined) D.knowledgeGraph = d.knowledgeGraph;
    if(d.lineage!==undefined) D.lineage = d.lineage;

    console.log("[AutoMate] pipelineResult received", Object.assign({}, D));

    if(d.generator){
      D.generator = d.generator;
      D.result = d.generator;
    } else if(d.result){
      D.result = d.result;
      if(!D.generator) D.generator = d.result;
    }

    if(d.profile){
      D.profile = d.profile;
      D.baseline = d.profile;
    } else if(d.baseline){
      D.baseline = d.baseline;
      if(!D.profile) D.profile = d.baseline;
    }

    if(d.leakage) D.leakage = d.leakage;
    if(d.scanReport) D.scanReport = d.scanReport;
    if(d.intelligence!==undefined) D.intelligence = d.intelligence;
    if(d.ast!==undefined) D.ast = d.ast;
    if(d.attackReport!==undefined) D.attackReport = d.attackReport;
    if(d.knowledgeGraph!==undefined) D.knowledgeGraph = d.knowledgeGraph;
    if(d.lineage!==undefined) D.lineage = d.lineage;

    console.log('[AutoMate] pipelineResult — rows:', (D.generator||D.result||{}).row_count,
      'samples:', D.generator?.samples?.length, 'leakage:', !!D.leakage, 'scan:', !!D.scanReport,
      'baseline cols:', Object.keys(((D.profile||D.baseline||{}).columns||{}).numeric||{}).length);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }
  if(msg.type==='aiResponse'){
    if(msg.error){
      document.getElementById('ai-status').textContent='⚠ Error';
      document.getElementById('ai-response').textContent='Error: '+msg.error;
      document.getElementById('ai-response').style.borderColor='rgba(248,113,113,.4)';
    } else {
      document.getElementById('ai-status').textContent='✓ Response received';
      document.getElementById('ai-response').textContent=msg.content||'No content returned.';
      document.getElementById('ai-response').style.borderColor='rgba(52,211,153,.3)';
      document.getElementById('ai-model').textContent='Model: '+(msg.model||'unknown');
    }
  }
  // ── Phase 4: Live Security Alert ──────────────────────────────────────
  if(msg.type==='liveSecurityAlert'&&msg.alert){
    appendLiveAlert(msg.alert);
    flashTicker(msg.alert);
  }
  if(msg.type==='liveSecuritySeed'&&msg.alerts){
    msg.alerts.forEach(function(a){ appendLiveAlert(a, false); });
    updateLiveStats();
  }
  // ── API key status response ──────────────────────────────────────────
  if(msg.type==='apiKeyStatus'){
    var banner=document.getElementById('agent-key-banner');
    var dot=document.getElementById('agent-ctx-dot');
    var row=document.getElementById('agent-config-row');
    // Hide inline config row once key is confirmed; show it if key is missing
    if(row) row.style.display=msg.configured?'none':'';
    if(banner) banner.style.display='none'; // inline config row replaces the old banner
    if(dot) dot.className='agent-ctx-dot '+(msg.configured?'ok':'warn');
    var tag=document.getElementById('agent-model-tag');
    if(tag) tag.textContent=msg.configured?('🤖 '+(msg.model||'OpenRouter')):'';
  }
  // ── Phase 5: Agent Chat response ──────────────────────────────────────
  if(msg.type==='agentResponse'){
    agentHandleResponse(msg.content, msg.model, msg.error);
  }
});

${agent_1.AGENT_SCRIPT}

${security_1.SECURITY_SCRIPT}

${livesecurity_1.LIVE_SECURITY_SCRIPT}

// ── End Phase 4 Live Security ────────────────────────────────────────────────

// ── Phase 3: Dataset Intelligence Risk (C14) ────────────────────────
function renderIntelligenceRisk(){
  var l=D.leakage||{};
  var dir=l.dataset_intelligence_risk||{};
  var score=dir.score;
  var label=dir.label;
  var brkdn=dir.breakdown||{};
  var valEl=document.getElementById('c14val');
  var arcEl=document.getElementById('c14arc');
  var badgeEl=document.getElementById('c14badge');
  var brkEl=document.getElementById('c14breakdown');
  var subEl=document.getElementById('c14sub');
  if(!valEl) return;
  if(!D.leakage || score==null){
    valEl.textContent='—';
    arcEl&&arcEl.setAttribute('stroke-dasharray','0 226');
    badgeEl&&(badgeEl.textContent='—');
    subEl&&(subEl.textContent=D.leakage?'Risk intelligence not computed':'Run the generator to view results.');
    return;
  }
  var fill=Math.round((score/100)*226);
  var color=score>=80?C.red:score>=60?C.orange:score>=30?C.p4:C.green;
  valEl.textContent=Math.round(score);
  valEl.style.color=color;
  arcEl&&arcEl.setAttribute('stroke-dasharray',fill+' '+(226-fill));
  arcEl&&arcEl.setAttribute('stroke',color);
  var badgeMap={CRITICAL:'rc-crit',HIGH:'rc-high',MODERATE:'rc-mod',LOW:'rc-low'};
  if(badgeEl){ badgeEl.textContent=label||'—'; badgeEl.className='rbadge '+(badgeMap[label]||'rc-unk'); }
  subEl&&(subEl.textContent='Intelligence risk: '+(label||'—'));
  if(brkEl){
    var lines=[
      ['Dataset Risk', brkdn.dataset_risk_contribution],
      ['Re-ID Risk',   brkdn.reidentification_contribution],
      ['PII Density',  brkdn.pii_density_contribution],
      ['Outliers',     brkdn.outlier_contribution],
      ['Privacy Gap',  brkdn.privacy_score_contribution],
    ];
    brkEl.innerHTML=lines.map(function(row){
      if(row[1]==null) return '';
      return '<div style="display:flex;justify-content:space-between"><span>'+esc(row[0])+'</span><span>'+row[1].toFixed(1)+'</span></div>';
    }).join('');
  }
}

// ── Phase 3: Sensitive Column Ranking (C15) ─────────────────────────
function renderColumnRanking(){
  var l=D.leakage||{};
  var ranking=(l.sensitive_column_ranking||[]).slice(0,5);
  var listEl=document.getElementById('c15list');
  var subEl=document.getElementById('c15sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
    return;
  }
  if(!ranking.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No sensitive column data available.</div>';
    return;
  }
  subEl&&(subEl.textContent='Top '+ranking.length+' sensitive columns · sorted by composite score');
  var maxScore=ranking[0].score||1;
  listEl.innerHTML=ranking.map(function(item,idx){
    var pctBar=Math.round((item.score/Math.max(maxScore,0.001))*100);
    var sig=item.signals||{};
    var piiPct=Math.round((sig.pii_score||0)*100);
    var reidPct=Math.round((sig.reidentification_risk||0)*100);
    var driftPct=Math.round((sig.drift_score||0)*100);
    var color=item.score>=0.7?C.red:item.score>=0.4?C.orange:C.p4;
    return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px 0;border-bottom:1px solid rgba(139,92,246,.08)">'+
      '<div style="display:flex;justify-content:space-between;align-items:center">'+
        '<span style="font-size:11px;font-weight:600;color:var(--fg)">'+(idx+1)+'. '+esc(item.column||'—')+'</span>'+
        '<span style="font-size:11px;font-weight:800;color:'+color+'">'+item.score.toFixed(2)+'</span>'+
      '</div>'+
      '<div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px">'+
        '<div style="height:4px;width:'+pctBar+'%;background:'+color+';border-radius:2px;transition:width .6s ease"></div>'+
      '</div>'+
      '<div style="display:flex;gap:8px;font-size:9px;color:var(--fg3)">'+
        '<span>PII: <span style="color:var(--fg2);font-weight:600">'+piiPct+'%</span></span>'+
        '<span>ReID: <span style="color:var(--fg2);font-weight:600">'+reidPct+'%</span></span>'+
        '<span>Drift: <span style="color:var(--fg2);font-weight:600">'+driftPct+'%</span></span>'+
      '</div>'+
    '</div>';
  }).join('');
}

// ── Phase 3: Privacy Recommendations (C16) ──────────────────────────
function renderRecommendations(){
  var l=D.leakage||{};
  var recs=((l.privacy_recommendations||{}).recommendations)||[];
  var listEl=document.getElementById('c16list');
  var subEl=document.getElementById('c16sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
    return;
  }
  if(!recs.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No recommendations generated.</div>';
    return;
  }
  subEl&&(subEl.textContent=recs.length+' recommendation'+(recs.length===1?'':'s'));
  listEl.innerHTML=recs.map(function(r){
    return '<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
      '<span style="color:var(--p4);flex-shrink:0;font-size:11px">&#9656;</span>'+
      '<span style="font-size:10px;color:var(--fg2);line-height:1.4">'+esc(r)+'</span>'+
    '</div>';
  }).join('');
}

// ── Lineage tab rendering ────────────────────────────────────────────

let _lastRenderHash = "";
let _lastActiveTab = "";

// ── PART 3: renderAll — uses activeTab global, not fragile DOM query ──
function renderAll(){
  console.log("[AutoMate] renderAll called");
  console.log("[AutoMate] generator rows:", D.generator?.row_count);
  console.log("[AutoMate] leakage:", !!D.leakage);
  console.log("[AutoMate] activeTab:", activeTab);

  // Reset render guards so new pipeline data always redraws tabs
  syntheticRendered=false;
  secRendered=false;
  try{renderSanityBanner();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderStrip();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderDatasetSummary();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRiskRadar();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC1();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC5();}catch(e){console.error("[AutoMate] render error",e)}   // Feature Drift Heatmap — must run after data loads
  try{renderC12();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRis();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderIntelligenceRisk();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderColumnRanking();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRecommendations();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderTimeline();}catch(e){console.error("[AutoMate] render error",e)}
  try{initDistCols();if(_distCols.length)renderDistributionComparison(_distCols[0]);}catch(e){console.error("[AutoMate] render error",e)}
  // Force-render whichever tab is active using stable global state
  switch(activeTab){
    case 'synthetic':
      try{syntheticRendered=false;renderSynthetic(true);}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'security':
      try{secRendered=false;renderSecurity();}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'livesecurity':
      try{renderLiveSecurity();}catch(err){console.error("[AutoMate] render error",err)}
      break;
    case 'aiinsights':
      try{initAgentChat();}catch(err){console.error("[AutoMate] render error",err)}
      break;
  }
  setTimeout(()=>{
    try{renderC2();}catch(e){}
  },150);
}

function _automate_init(){
  setTimeout(()=>{
    renderAll();
  },100);
}

/* Boot — defined here, so _automate_init is guaranteed to exist */
_automate_init();

console.log("[AutoMate] tab panes:", document.querySelectorAll(".tabpane").length);
</script>
</body>
</html>`;
}


/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RISK_RADAR_SCRIPT = exports.DASHBOARD_STYLES = exports.CHART_INLINE_FALLBACK_SCRIPT = void 0;
exports.CHART_INLINE_FALLBACK_SCRIPT = String.raw `
if(typeof Chart==='undefined'){
(function(global){
  function Chart(canvas,cfg){
    this.canvas=canvas; this.cfg=cfg; this.destroyed=false;
    this._draw();
  }
  Chart.prototype.destroy=function(){ this.destroyed=true; };
  Chart.prototype.update=function(){ if(!this.destroyed) this._draw(); };
  Chart.prototype._draw=function(){
    var canvas=this.canvas, cfg=this.cfg;
    if(!canvas) return;
    var ctx=canvas.getContext('2d');
    if(!ctx) return;
    var W=canvas.width||canvas.offsetWidth||200;
    var H=canvas.height||canvas.offsetHeight||120;
    canvas.width=W; canvas.height=H;
    ctx.clearRect(0,0,W,H);
    var type=cfg.type||'bar';
    var ds=(cfg.data&&cfg.data.datasets)||[];
    var labels=(cfg.data&&cfg.data.labels)||[];
    if(type==='doughnut'||type==='pie'){
      var vals=ds[0]&&ds[0].data||[]; var colors=ds[0]&&ds[0].backgroundColor||[];
      var circ=cfg.data&&cfg.data.datasets[0].circumference;
      var rot=cfg.data&&cfg.data.datasets[0].rotation;
      var startAngle=(rot!=null?rot*Math.PI/180:0)-Math.PI/2;
      var totalAngle=(circ!=null?circ*Math.PI/180:2*Math.PI);
      var total=vals.reduce(function(a,b){return a+(+b||0);},0)||1;
      var cx=W/2, cy=H/2, r=Math.min(W,H)*0.42;
      var cutout=parseFloat(cfg.options&&cfg.options.cutout)||0;
      var ir=typeof cutout==='string'?r*(parseFloat(cutout)/100):cutout;
      var a=startAngle;
      vals.forEach(function(v,i){
        var sweep=(+v/total)*totalAngle;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.arc(cx,cy,r,a,a+sweep); ctx.closePath();
        ctx.fillStyle=Array.isArray(colors)?colors[i]||'#8b5cf6':colors;
        ctx.fill();
        a+=sweep;
      });
      if(ir>0){
        ctx.beginPath(); ctx.arc(cx,cy,ir,0,2*Math.PI);
        ctx.fillStyle='rgba(23,23,35,1)'; ctx.fill();
      }
    } else {
      /* bar / line */
      var pad=28, bottom=H-pad, top=12;
      var allVals=[];
      ds.forEach(function(d){ (d.data||[]).forEach(function(v){ allVals.push(+v||0); }); });
      var maxV=Math.max.apply(null,allVals.concat([0]))||1;
      var minV=Math.min.apply(null,allVals.concat([0]));
      if(minV>0) minV=0;
      var range=maxV-minV||1;
      var n=Math.max(labels.length,ds[0]&&ds[0].data&&ds[0].data.length||0,1);
      var slotW=(W-pad)/n;
      var barW=slotW*0.5;
      /* y-axis grid */
      ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=0.5;
      for(var gi=0;gi<=4;gi++){
        var gy=top+(bottom-top)*(gi/4);
        ctx.beginPath(); ctx.moveTo(pad,gy); ctx.lineTo(W,gy); ctx.stroke();
      }
      ds.forEach(function(d,di){
        var dvals=d.data||[];
        var color=Array.isArray(d.backgroundColor)?d.backgroundColor[0]:d.backgroundColor||'rgba(139,92,246,.7)';
        var bcolor=d.borderColor||color;
        var isLine=(d.type==='line'||type==='line');
        if(isLine){
          ctx.beginPath(); ctx.strokeStyle=bcolor; ctx.lineWidth=d.borderWidth||1.5;
          dvals.forEach(function(v,i){
            var x=pad+i*slotW+slotW/2;
            var y=bottom-((+v-minV)/range)*(bottom-top);
            i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
          });
          ctx.stroke();
        } else {
          var bw=barW/(ds.filter(function(dd){return dd.type!=='line';}).length||1);
          dvals.forEach(function(v,i){
            var x=pad+i*slotW+(slotW-barW)/2+di*bw;
            var y=bottom-((+v-minV)/range)*(bottom-top);
            var h=bottom-y;
            if(h<0){y=bottom+Math.abs(h);h=Math.abs(h);}
            ctx.fillStyle=Array.isArray(d.backgroundColor)?d.backgroundColor[i]||color:color;
            ctx.beginPath();
            var rx=Math.min(3,bw/2);
            ctx.roundRect?ctx.roundRect(x,y,bw,h,rx):ctx.rect(x,y,bw,h);
            ctx.fill();
          });
        }
      });
      /* x labels */
      ctx.fillStyle='rgba(155,142,196,.6)'; ctx.font='9px sans-serif'; ctx.textAlign='center';
      labels.slice(0,n).forEach(function(lbl,i){
        var x=pad+i*slotW+slotW/2;
        ctx.fillText(String(lbl).substring(0,6),x,H-6);
      });
    }
  };
  global.Chart=Chart;
})(window);
}
`;
exports.DASHBOARD_STYLES = String.raw `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f0f17;--bg2:#13131f;--bg3:#171723;
  --card:#171723;--card2:#1e1e2e;--card3:#252538;
  --fg:#ede5f8;--fg2:#9b8ec4;--fg3:#524870;
  --border:rgba(139,92,246,.18);--border2:rgba(139,92,246,.38);
  --p0:#1e0057;--p1:#4c1d95;--p2:#6d28d9;--p3:#7c3aed;
  --p4:#8b5cf6;--p5:#a78bfa;--p6:#c084fc;--p7:#ddd6fe;
  --glow:rgba(139,92,246,.45);--glow2:rgba(139,92,246,.18);
  --green:#34d399;--red:#f87171;--orange:#fb923c;--yellow:#fbbf24;
  --grad:linear-gradient(135deg,#7c3aed,#9333ea,#a855f7,#c084fc);
  --r:12px;
  --font:var(--vscode-font-family,-apple-system,'Segoe UI',Roboto,sans-serif);
}
html,body{min-height:100%;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;line-height:1.5;overflow-x:hidden}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--p3);border-radius:3px}

/* Sticky header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--border);background:rgba(15,15,23,.96);position:sticky;top:0;z-index:100;backdrop-filter:blur(18px)}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;flex-shrink:0;border-radius:10px;background:var(--grad);display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 16px var(--glow)}
.logo-title{font-size:15px;font-weight:700;letter-spacing:-.025em;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-sub{font-size:10px;color:var(--fg2);margin-top:1px}
.hdr-right{display:flex;gap:6px}
.hbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 13px;border-radius:8px;font-size:11px;font-weight:500;cursor:pointer;border:none;transition:all .15s}
.hbtn-g{background:transparent;color:var(--fg2);border:1px solid var(--border2)}
.hbtn-g:hover{background:var(--card2);color:var(--fg);border-color:var(--p4)}
.hbtn-p{background:var(--grad);color:#fff;box-shadow:0 2px 12px rgba(124,58,237,.45)}
.hbtn-p:hover{opacity:.87;box-shadow:0 2px 18px rgba(124,58,237,.65)}

/* Status strip */
.strip{display:flex;gap:6px;padding:8px 20px;border-bottom:1px solid var(--border);background:var(--bg2);overflow-x:auto;flex-shrink:0}
.spill{display:flex;align-items:center;gap:10px;padding:5px 14px;background:var(--card);border:1px solid var(--border);border-radius:20px;white-space:nowrap;flex-shrink:0;transition:border-color .2s}
.spill:hover{border-color:var(--border2)}
.sl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em}
.sv{font-size:12px;font-weight:700;margin-top:1px}

/* Tabs */
.tabs{display:flex;gap:2px;padding:8px 20px 0;background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:6px 15px;font-size:11px;font-weight:500;cursor:pointer;border:none;background:transparent;color:var(--fg2);border-radius:8px 8px 0 0;transition:all .15s;white-space:nowrap;border-bottom:2px solid transparent}
.tab.active{background:var(--card);color:var(--fg);border-bottom-color:var(--p4)}
.tab:hover:not(.active){background:var(--card2);color:var(--fg)}
.tabpane{display:none}
.tabpane.active{display:block}

/* 3-column grid */
.grid{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:minmax(220px,auto);gap:18px;padding:18px 22px 32px}
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px) {.grid{grid-template-columns:1fr}}

/* Card */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:9px;position:relative;overflow:hidden;transition:border-color .22s,box-shadow .22s}
.card:hover{border-color:var(--border2);box-shadow:0 10px 32px rgba(168,85,247,.35)}
.card::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 0% 0%,rgba(139,92,246,.07) 0%,transparent 65%)}
.card.span2{grid-column:span 2}
.ch{display:flex;align-items:flex-start;justify-content:space-between;gap:5px}
.ct{font-size:13px;font-weight:600;letter-spacing:-.01em}
.cs{font-size:10px;color:var(--fg2);margin-top:2px;line-height:1.4}
.ib{background:var(--card2);border:none;color:var(--fg2);cursor:pointer;width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;transition:all .15s;flex-shrink:0}
.ib:hover{background:var(--p3);color:#fff}

/* Buttons */
.abtn{padding:7px 14px;border:none;border-radius:9px;margin-top:auto;background:var(--grad);color:#fff;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(124,58,237,.4);transition:all .15s;width:100%}
.abtn:hover{opacity:.85;box-shadow:0 2px 16px rgba(124,58,237,.6)}
.agbtn{padding:6px;border:1px solid var(--border2);border-radius:9px;background:transparent;color:var(--fg2);font-size:11px;font-weight:500;cursor:pointer;transition:all .15s;margin-top:auto;text-align:center;width:100%}
.agbtn:hover{background:var(--card2);color:var(--fg);border-color:var(--p4)}

/* Big number */
.bnum{font-size:32px;font-weight:800;line-height:1;letter-spacing:-.04em;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.bsub{font-size:10px;color:var(--fg2);margin-top:3px}

/* Risk badge */
.rbadge{display:inline-block;padding:2px 9px;border-radius:9px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.rc-crit{background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.28)}
.rc-warn{background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.28)}
.rc-low {background:rgba(52,211,153,.10);color:#34d399;border:1px solid rgba(52,211,153,.25)}
.rc-unk {background:rgba(139,92,246,.12);color:var(--p5);border:1px solid var(--border2)}
.badge-warning{display:inline-block;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.28);cursor:default;margin-left:6px}
.metric-badge{margin-left:6px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
.metric-subtext{font-size:11px;opacity:0.75;margin-top:4px;text-align:center}

/* Donut */
.dw{position:relative;width:120px;height:120px;margin:0 auto;flex-shrink:0}
.dc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.dv{font-size:24px;font-weight:800;letter-spacing:-.03em}
.dl{font-size:9px;color:var(--fg2);text-transform:uppercase;letter-spacing:.07em}
.dct{text-align:center;font-size:12px;font-weight:600}

/* Legend */
.leg{display:flex;flex-wrap:wrap;gap:7px;justify-content:center}
.li{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--fg2)}
.ld{width:6px;height:6px;border-radius:50%;flex-shrink:0}

/* Mini bars */
.mbars{display:flex;align-items:flex-end;gap:3px;flex:1;min-height:56px}
.mb{flex:1;border-radius:3px 3px 0 0;min-height:4px;background:linear-gradient(to top,var(--p2),var(--p4));transition:height .45s cubic-bezier(.34,1.5,.64,1)}
.mb.dim{background:var(--card3)}
.mb.hot{background:linear-gradient(to top,var(--red),#f43f5e)}
.mb.warm{background:linear-gradient(to top,var(--p2),var(--p4))}
.mb.cool{background:linear-gradient(to top,var(--p3),var(--p6))}

/* Skill bars */
.skills{display:flex;flex-direction:column;gap:7px;flex:1}
.sk{display:flex;flex-direction:column;gap:3px}
.skl{display:flex;justify-content:space-between;font-size:10px;color:var(--fg2)}
.skt{height:5px;background:var(--card3);border-radius:3px;overflow:hidden}
.skf{height:100%;border-radius:3px;transition:width .65s cubic-bezier(.34,1.2,.64,1)}
.sk1{background:linear-gradient(90deg,var(--p2),var(--p5))}
.sk2{background:linear-gradient(90deg,var(--p1),var(--p4))}
.sk3{background:linear-gradient(90deg,var(--p3),var(--p6))}
.sk4{background:linear-gradient(90deg,#059669,#34d399)}

/* Metric row */
.mvrow{display:flex;align-items:center;justify-content:space-between}
.mvl{font-size:10px;color:var(--fg2)}
.mvv{font-size:18px;font-weight:800;letter-spacing:-.02em}

/* Sparkline */
.sw{height:36px}

/* Canvas */
canvas{max-width:100%}
.cbox{flex:1;position:relative;min-height:72px;max-height:110px}

/* Heatmap */
.hmap{display:grid;gap:2px;flex:1}
.hc{border-radius:3px;aspect-ratio:1;cursor:pointer;transition:opacity .15s}
.hc:hover{opacity:.7}

/* Concentric rings */
.rw{position:relative;width:140px;height:140px;margin:2px auto;flex-shrink:0}
.rc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.rv{font-size:24px;font-weight:800;letter-spacing:-.04em}
.rl{font-size:9px;color:var(--fg2);text-transform:uppercase;letter-spacing:.07em}
.pchip{display:inline-block;padding:3px 10px;border-radius:11px;background:var(--card2);border:1px solid var(--border);font-size:9px;font-weight:500;color:var(--fg2)}

/* Pipeline timeline */
.timeline{display:flex;flex-direction:column;gap:6px;flex:1}
.tl-step{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card2);transition:border-color .2s}
.tl-step.done{border-color:rgba(52,211,153,.3)}
.tl-step.fail{border-color:rgba(248,113,113,.3)}
.tl-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--fg3)}
.tl-step.done .tl-dot{background:var(--green)}
.tl-step.fail .tl-dot{background:var(--red)}
.tl-step.active .tl-dot{background:var(--p4);box-shadow:0 0 8px var(--glow)}
.tl-name{font-size:11px;font-weight:600;flex:1}
.tl-info{font-size:10px;color:var(--fg2)}

/* Status note */
.snote{padding:6px;text-align:center;font-size:10px;color:var(--fg2);border:1px solid var(--border);border-radius:8px;margin-top:auto}

/* Schema table */
.stab-grid{padding:14px 20px}
.stab-table{width:100%;border-collapse:collapse;font-size:12px}
.stab-table th{text-align:left;padding:6px 10px;background:var(--card2);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg2);position:sticky;top:0}
.stab-table td{padding:6px 10px;border-bottom:1px solid rgba(139,92,246,.07)}
.stab-table tr:hover td{background:rgba(139,92,246,.04)}

/* Synthetic table */
.preview-wrap{overflow-x:auto;padding:14px 20px}
.preview-table{border-collapse:collapse;font-size:11px;white-space:nowrap}
.preview-table th{padding:5px 10px;background:var(--card2);font-size:10px;font-weight:600;color:var(--fg2);text-align:left;border-bottom:1px solid var(--border)}
.preview-table td{padding:4px 10px;border-bottom:1px solid rgba(139,92,246,.06);color:var(--fg2)}
.preview-table tr:hover td{background:rgba(139,92,246,.05);color:var(--fg)}

/* Threats */
.threats-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:10px}
.threat-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:5px}
.threat-card.sev-high{border-color:rgba(248,113,113,.38)}
.threat-card.sev-medium{border-color:rgba(251,146,60,.38)}
.threat-card.sev-low{border-color:rgba(52,211,153,.28)}
.thr-name{font-size:13px;font-weight:600}
.thr-desc{font-size:11px;color:var(--fg2);line-height:1.5}
.thr-cols{font-size:10px;color:var(--fg3)}

/* Diagnostics */
.diag-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:8px}
.diag-row{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px}
.diag-key{font-size:11px;color:var(--fg2)}
.diag-val{font-size:12px;font-weight:600}

/* Misc */
.btmrow{display:flex;align-items:center;justify-content:space-between;margin-top:auto}
.bpct{font-size:20px;font-weight:800;letter-spacing:-.03em}

/* PII column badge */
.pii-col-badge{background:rgba(251,146,60,.12);border:1px solid rgba(251,146,60,.28);padding:1px 6px;border-radius:5px;font-size:9px;font-weight:600;color:#fb923c}

/* Distribution Comparison */
.dist-sel{background:var(--card2);border:1px solid var(--border2);color:var(--fg);border-radius:7px;padding:3px 8px;font-size:11px;cursor:pointer;outline:none;width:100%}
.dist-sel:focus{border-color:var(--p4)}
.dist-legend{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.dist-li{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--fg2)}
.dist-dot{width:8px;height:2px;border-radius:1px;flex-shrink:0}

/* Correlation heatmap */
.corr-wrap{flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center}
.corr-tbl{border-collapse:collapse;font-size:9px;table-layout:fixed}
.corr-tbl th{padding:3px 6px;color:var(--fg3);font-weight:500;text-align:center;white-space:nowrap;font-size:9px;max-width:60px;overflow:hidden;text-overflow:ellipsis}
.corr-tbl thead th:first-child{min-width:56px}
.corr-tbl tbody th{text-align:right;padding:2px 8px 2px 4px;color:var(--fg2);font-weight:500;white-space:nowrap;font-size:9px;min-width:56px}
.corr-tbl td{width:36px;height:36px;text-align:center;font-size:9px;font-weight:600;cursor:default;border-radius:4px;transition:opacity .15s;border:2px solid transparent}
.corr-tbl td:hover{opacity:.8;border-color:rgba(255,255,255,.18)}

/* Fingerprint card */
.fp-row{display:flex;flex-direction:column;gap:4px;padding:7px 10px;background:var(--card2);border:1px solid var(--border);border-radius:8px}
.fp-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg3)}
.fp-hash{font-family:monospace;font-size:11px;color:var(--p5);word-break:break-all;letter-spacing:.04em}
.fp-copy{margin-top:3px;padding:2px 8px;font-size:9px;border:1px solid var(--border2);border-radius:5px;background:transparent;color:var(--fg3);cursor:pointer;transition:all .15s;float:right}
.fp-copy:hover{background:var(--card3);color:var(--fg);border-color:var(--p4)}

/* Sanity warning banner */
.warn-banner{margin:10px 20px 0;padding:8px 14px;background:rgba(251,146,60,.1);border:1px solid rgba(251,146,60,.35);border-radius:9px;font-size:11px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.warn-item{color:#fb923c;display:flex;align-items:center;gap:4px}
.crit-banner{background:rgba(248,113,113,.09);border-color:rgba(248,113,113,.32)}
.crit-banner .warn-item{color:#f87171}

/* Privacy risk breakdown */
.prisk-list{display:flex;flex-direction:column;gap:7px;flex:1}
.prisk-row{display:flex;flex-direction:column;gap:3px}
.prisk-lbl{display:flex;justify-content:space-between;font-size:10px;color:var(--fg2)}
.prisk-bar{height:6px;background:var(--card3);border-radius:3px;overflow:hidden}
.prisk-fill{height:100%;border-radius:3px;transition:width .65s cubic-bezier(.34,1.2,.64,1)}

/* Drift heatmap rows */
.dh-row{display:flex;align-items:center;gap:6px;font-size:10px;padding:3px 0;border-bottom:1px solid rgba(139,92,246,.06)}
.dh-lbl{width:90px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.dh-bar-wrap{flex:1;height:8px;background:var(--card3);border-radius:4px;overflow:hidden}
.dh-bar-fill{height:100%;border-radius:4px;transition:width .55s ease}
.dh-val{width:40px;text-align:right;color:var(--fg3);font-size:9px}

/* Column explorer */
.col-grid{display:grid;grid-template-columns:180px 1fr;gap:0;flex:1;overflow:hidden}
.col-list{overflow-y:auto;border-right:1px solid var(--border);padding:6px 0}
.col-item{padding:6px 14px;font-size:11px;cursor:pointer;border-left:2px solid transparent;transition:all .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.col-item:hover{background:var(--card2);color:var(--fg)}
.col-item.selected{border-left-color:var(--p4);background:rgba(139,92,246,.08);color:var(--p5)}
.col-detail{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.col-stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.col-stat{background:var(--card2);border-radius:8px;padding:8px;text-align:center}
.col-stat-v{font-size:16px;font-weight:700;color:var(--p5)}
.col-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase;margin-top:2px}

/* Collapsible threat details */
.thr-toggle{background:none;border:none;color:var(--fg3);font-size:10px;cursor:pointer;padding:0;text-align:left;margin-top:3px}
.thr-toggle:hover{color:var(--p5)}
.thr-body{display:none;margin-top:5px;padding:8px;background:var(--card2);border-radius:7px;font-size:11px;color:var(--fg2);line-height:1.6}
.thr-body.open{display:block}

/* Table sort */
.preview-table th{cursor:pointer;user-select:none}
.preview-table th:hover{color:var(--p5)}
.sort-icon{margin-left:3px;opacity:.5;font-size:9px}
.copy-row-btn{padding:1px 6px;font-size:9px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg3);cursor:pointer;margin-left:4px;transition:all .15s}
.copy-row-btn:hover{background:var(--card2);color:var(--fg);border-color:var(--p4)}

/* Security scan tab */
.sec-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.sec-stat{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center}
.sec-stat-v{font-size:22px;font-weight:800}
.sec-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase;margin-top:3px}
.sec-finding{padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:10px;margin-bottom:4px}
.sec-finding .sf-type{font-size:9px;text-transform:uppercase;font-weight:700;width:60px;flex-shrink:0}
.sec-finding .sf-cat{font-size:11px;color:var(--fg2);flex:1}
.sec-finding .sf-sev{font-size:9px;padding:2px 8px;border-radius:8px}

/* Live Security tab */
.lsec-wrap{padding:14px 20px}
.lsec-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.lsec-title{font-size:14px;font-weight:700;color:var(--p6)}
.lsec-badge{font-size:10px;padding:3px 10px;border-radius:12px;font-weight:700}
.lsec-badge.safe{background:rgba(52,211,153,.15);color:var(--green)}
.lsec-badge.active{background:rgba(248,113,113,.15);color:var(--red);animation:pulse-badge 2s infinite}
@keyframes pulse-badge{0%,100%{opacity:1}50%{opacity:.5}}
.lsec-controls{display:flex;gap:6px}
.lsec-btn{padding:4px 10px;font-size:10px;border:1px solid var(--border2);border-radius:6px;background:transparent;color:var(--fg2);cursor:pointer;transition:all .15s}
.lsec-btn:hover{background:var(--card2);color:var(--fg)}
.lsec-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:14px}
.lsec-stat-box{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center}
.lsec-stat-n{font-size:20px;font-weight:800;margin-bottom:2px}
.lsec-stat-l{font-size:9px;color:var(--fg3);text-transform:uppercase}
.lsec-filter{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.lsec-chip{padding:3px 10px;border-radius:12px;font-size:10px;border:1px solid var(--border);background:var(--card);color:var(--fg2);cursor:pointer;transition:all .15s}
.lsec-chip.active{background:var(--p3);color:#fff;border-color:var(--p3)}
.lsec-chip:hover:not(.active){border-color:var(--border2);color:var(--fg)}
.lsec-table-wrap{overflow-x:auto}
.lsec-table{width:100%;border-collapse:collapse;font-size:11px}
.lsec-table th{text-align:left;padding:6px 10px;background:var(--card2);font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);border-bottom:1px solid var(--border);white-space:nowrap}
.lsec-table td{padding:7px 10px;border-bottom:1px solid rgba(139,92,246,.06);vertical-align:middle}
.lsec-table tr:hover td{background:rgba(139,92,246,.04)}
.lsec-sev{font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;text-transform:uppercase}
.lsec-sev.critical{background:rgba(248,113,113,.18);color:#f87171}
.lsec-sev.high{background:rgba(251,146,60,.18);color:#fb923c}
.lsec-sev.medium{background:rgba(251,191,36,.15);color:#fbbf24}
.lsec-sev.low{background:rgba(52,211,153,.12);color:var(--green)}
.lsec-policy{font-size:9px;padding:2px 7px;border-radius:8px}
.lsec-policy.blocked{background:rgba(248,113,113,.15);color:#f87171}
.lsec-policy.warned{background:rgba(251,191,36,.12);color:#fbbf24}
.lsec-policy.logged{background:rgba(139,92,246,.1);color:var(--p5)}
.lsec-snippet{font-family:monospace;font-size:10px;color:var(--fg3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lsec-empty{text-align:center;padding:40px 20px;color:var(--fg3);font-size:12px}
.lsec-ticker{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.2);border-radius:8px;margin-bottom:12px;font-size:11px;color:var(--fg2)}
.lsec-ticker-dot{width:8px;height:8px;border-radius:50%;background:#f87171;animation:pulse-badge 1.5s infinite;flex-shrink:0}

/* AI chat (legacy — kept for backward compat) */
.ai-wrap{padding:14px 20px;display:flex;flex-direction:column;gap:12px;min-height:300px}
.ai-input-row{display:flex;gap:8px}
.ai-input{flex:1;background:var(--card2);border:1px solid var(--border2);color:var(--fg);border-radius:8px;padding:8px 12px;font-size:12px;font-family:var(--font);outline:none}
.ai-input:focus{border-color:var(--p4)}
.ai-send{background:var(--grad);color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.ai-send:hover{opacity:.85}
.ai-response{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:12px;color:var(--fg2);line-height:1.7;white-space:pre-wrap;min-height:60px}
.ai-model{font-size:9px;color:var(--fg3);text-align:right;margin-top:4px}

/* Phase 5 — Agent Chat Panel */
.agent-layout{display:grid;grid-template-columns:210px 1fr;height:calc(100vh - 210px);min-height:420px;overflow:hidden}
.agent-sidebar{background:var(--bg2);border-right:1px solid var(--border);padding:10px 8px;display:flex;flex-direction:column;gap:5px;overflow-y:auto;flex-shrink:0}
.agent-sidebar-hdr{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);padding:2px 6px 6px;border-bottom:1px solid var(--border);margin-bottom:4px}
.aab{padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg2);font-size:10px;cursor:pointer;text-align:left;transition:all .15s;display:flex;align-items:flex-start;gap:7px;line-height:1.3}
.aab:hover{background:var(--card2);color:var(--fg);border-color:var(--p4)}
.aab .aab-icon{font-size:14px;flex-shrink:0;margin-top:1px}
.aab .aab-label{font-weight:600;display:block;margin-bottom:1px}
.aab .aab-desc{font-size:9px;color:var(--fg3);display:block}
.agent-main{display:flex;flex-direction:column;overflow:hidden}
.agent-history{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.agent-msg{max-width:88%;display:flex;flex-direction:column;gap:3px}
.agent-msg.user{align-self:flex-end;align-items:flex-end}
.agent-msg.assistant{align-self:flex-start;align-items:flex-start}
.agent-bubble{padding:9px 13px;border-radius:12px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.agent-msg.user .agent-bubble{background:var(--p3);color:#fff;border-bottom-right-radius:3px}
.agent-msg.assistant .agent-bubble{background:var(--card2);color:var(--fg);border:1px solid var(--border);border-bottom-left-radius:3px}
.agent-msg-meta{font-size:9px;color:var(--fg3)}
.agent-thinking{display:flex;gap:5px;padding:10px 14px;background:var(--card2);border:1px solid var(--border);border-radius:12px;border-bottom-left-radius:3px;align-self:flex-start}
.agent-thinking span{width:6px;height:6px;border-radius:50%;background:var(--p4);animation:agent-bounce 1.2s infinite}
.agent-thinking span:nth-child(2){animation-delay:.2s}
.agent-thinking span:nth-child(3){animation-delay:.4s}
@keyframes agent-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
.agent-input-area{padding:10px 12px;border-top:1px solid var(--border);background:var(--bg2);display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
.agent-input{flex:1;background:var(--card);border:1px solid var(--border2);color:var(--fg);border-radius:10px;padding:8px 12px;font-size:12px;font-family:var(--font);outline:none;resize:none;line-height:1.5;min-height:36px;max-height:120px;overflow-y:auto}
.agent-input:focus{border-color:var(--p4)}
.agent-send-btn{padding:8px 14px;background:var(--grad);color:#fff;border:none;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.agent-send-btn:hover{opacity:.87}
.agent-send-btn:disabled{opacity:.4;cursor:default}
.agent-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:30px;color:var(--fg3);text-align:center}
.agent-empty-icon{font-size:38px;margin-bottom:10px}
.agent-empty-title{font-size:13px;font-weight:600;color:var(--fg2);margin-bottom:6px}
.agent-empty-sub{font-size:11px;line-height:1.5}
.agent-sql{background:#0d1117;border:1px solid rgba(139,92,246,.3);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:11px;color:#e2c9ff;margin:4px 0;position:relative}
.agent-sql-copy{position:absolute;top:6px;right:8px;font-size:9px;padding:2px 7px;border:1px solid rgba(139,92,246,.4);border-radius:4px;background:transparent;color:var(--p5);cursor:pointer;transition:background .15s}
.agent-sql-copy:hover{background:rgba(139,92,246,.18)}
.agent-ctx-bar{display:flex;align-items:center;gap:8px;padding:5px 16px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:10px;color:var(--fg3);flex-shrink:0}
.agent-ctx-dot{width:7px;height:7px;border-radius:50%}
.agent-ctx-dot.ok{background:var(--green)}
.agent-ctx-dot.warn{background:var(--yellow)}
.agent-ctx-dot.none{background:var(--fg3)}
.agent-config{display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(251,146,60,.06);border-bottom:1px solid rgba(251,146,60,.25);flex-shrink:0;flex-wrap:wrap}
.agent-config label{font-size:10px;color:#fb923c;font-weight:600;white-space:nowrap}
.agent-config-input{flex:1;min-width:220px;max-width:380px;background:var(--card);border:1px solid rgba(251,146,60,.4);border-radius:7px;color:var(--fg);font-size:11px;padding:5px 10px;outline:none}
.agent-config-input:focus{border-color:#fb923c}
.agent-config-btn{padding:5px 12px;background:rgba(251,146,60,.18);border:1px solid rgba(251,146,60,.45);border-radius:7px;color:#fb923c;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap}
.agent-config-btn:hover{background:rgba(251,146,60,.30)}
.agent-config-ok{font-size:10px;color:var(--green);margin-left:4px}

/* Lineage */
.lineage-wrap{padding:14px 20px}
.lin-step{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;position:relative}
.lin-step::before{content:'';position:absolute;left:24px;top:100%;width:2px;height:6px;background:var(--border)}
.lin-step:last-child::before{display:none}
.lin-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;background:var(--p4);box-shadow:0 0 8px var(--glow)}
.lin-dot.fail{background:var(--red)}
.lin-name{font-size:12px;font-weight:600;flex:1}
.lin-meta{font-size:10px;color:var(--fg3)}
.lin-hash{font-family:monospace;font-size:9px;color:var(--p5);letter-spacing:.04em}

/* Knowledge graph */
.kg-wrap{padding:14px 20px}
.kg-entity{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:var(--card2);border:1px solid var(--border2);border-radius:20px;margin:3px;font-size:11px;color:var(--p5);font-weight:500;cursor:default;transition:all .15s}
.kg-entity:hover{background:rgba(139,92,246,.15);border-color:var(--p4)}
.kg-edge{font-size:10px;color:var(--fg3);padding:4px 0;margin-left:20px}
/* Privacy Attack Gauges */
.atk-gauges{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.atk-gauge{flex:1;min-width:110px;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.atk-gauge-ring{position:relative;width:72px;height:72px}
.atk-gauge-val{font-size:18px;font-weight:800;letter-spacing:-.03em}
.atk-gauge-lbl{font-size:9px;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;text-align:center;line-height:1.3}
/* Dataset Reliability card */
.ris-bar{height:8px;background:var(--card3);border-radius:4px;overflow:hidden;margin:6px 0}
.ris-fill{height:100%;border-radius:4px;transition:width .7s cubic-bezier(.34,1.2,.64,1)}
/* PART 10: Agent chat bubble styles */
.agent-chat{display:flex;flex-direction:column;height:calc(100vh - 260px);min-height:340px;padding:14px 20px;gap:0}
.agent-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:12px}
.agent-user{background:#6c4cff;color:#fff;padding:10px 14px;border-radius:14px 14px 4px 14px;font-size:12px;line-height:1.6;align-self:flex-end;max-width:75%;word-break:break-word;box-shadow:0 2px 12px rgba(108,76,255,.35)}
.agent-ai{background:var(--card2);color:var(--fg);border:1px solid var(--border);padding:10px 14px;border-radius:14px 14px 14px 4px;font-size:12px;line-height:1.65;align-self:flex-start;max-width:85%;word-break:break-word;white-space:pre-wrap}
.agent-ai.thinking{opacity:.6;font-style:italic}
.agent-input-row{display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--border);flex-shrink:0}
.agent-text-input{flex:1;background:var(--card);border:1px solid var(--border2);color:var(--fg);border-radius:10px;padding:9px 13px;font-size:12px;font-family:var(--font);outline:none}
.agent-text-input:focus{border-color:var(--p4)}
.agent-send-simple{padding:9px 18px;background:var(--grad);color:#fff;border:none;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.agent-send-simple:hover{opacity:.85}
.agent-send-simple:disabled{opacity:.4;cursor:default}
`;
exports.RISK_RADAR_SCRIPT = String.raw `
function renderRiskRadar(){
  const l = D.leakage || {};
  const rs = l.dataset_risk_score ?? 0;
  const ps = l.privacy_score != null ? l.privacy_score * 100 : 0;
  
  const reidInfo = l.reidentification_risk || {};
  const reidVals = Object.values(reidInfo);
  const maxReid = reidVals.length ? Math.max(...(reidVals as number[])) * 100 : 0;
  
  const ds = l.avg_drift_score != null ? Math.min(l.avg_drift_score * 100, 100) : 0;

  getOrCreateChart('chart-radar', {
    type: 'radar',
    data: {
      labels: ['Privacy', 'Risk', 'Max ReID', 'Drift'],
      datasets: [{
        label: 'Risk Radar',
        data: [ps, rs, maxReid, ds],
        backgroundColor: 'rgba(139, 92, 246, 0.25)',
        borderColor: 'rgba(139, 92, 246, 0.8)',
        borderWidth: 2,
        pointBackgroundColor: 'var(--p4)',
        pointBorderColor: '#fff',
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: 'var(--p6)'
      }]
    },
    options: {
      elements: { line: { tension: 0.3 } },
      scales: { 
        r: { 
          angleLines: { color: 'rgba(255, 255, 255, 0.1)' }, 
          grid: { color: 'rgba(255, 255, 255, 0.1)' }, 
          pointLabels: { color: 'var(--fg2)', font: { size: 9, family: 'var(--font)' } }, 
          ticks: { display:false, min:0, max:100 } 
        } 
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 600 }
    }
  });
}
`;


/***/ }),
/* 8 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.OVERVIEW_SCRIPT = exports.OVERVIEW_TAB_HTML = void 0;
exports.OVERVIEW_TAB_HTML = String.raw `
<!-- TAB: Overview -->
<div id="pane-overview" class="tabpane active">
<div class="grid">

  <!-- Dataset Summary Card -->
  <div class="card" id="card-summary">
    <div class="ch">
      <div><div class="ct">Dataset Summary</div><div class="cs">Baseline data stats</div></div>
      <button class="ib" title="Basic dataset characteristics">&#9432;</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;flex:1;justify-content:center" id="ds-summary-body">
      <div style="color:var(--fg3);font-size:11px">Run pipeline to view summary.</div>
    </div>
  </div>

  <!-- Privacy Risk Radar Chart -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Privacy Risk Radar</div><div class="cs">Multi-dimensional risk</div></div>
      <button class="ib">&#9881;</button>
    </div>
    <div class="cbox" style="display:flex;align-items:center;justify-content:center">
      <canvas id="chart-radar" style="max-height:160px"></canvas>
    </div>
  </div>

  <!-- C1: SynthDataGen -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">SynthDataGen</div><div class="cs" id="c1s">Ready to generate</div></div>
      <button class="ib">&#8942;</button>
    </div>
    <div><div class="bnum" id="c1n">&#8212;</div><div class="bsub">rows generated</div></div>
    <div class="mbars" id="c1bars"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <label style="font-size:11px;color:var(--fg2)">Rows:</label>
      <input id="gen-n" type="number" value="500" min="1" max="10000"
        style="width:80px;background:var(--card2);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:12px;padding:3px 8px"/>
    </div>
    <div id="gen-status" style="font-size:11px;color:var(--fg2);min-height:14px;margin-bottom:4px"></div>
    <button class="abtn" id="gen-btn" onclick="reqGen()">&#9654; Run Generator</button>
  </div>

  <!-- C2: Privacy Score donut -->
  <div class="card" style="align-items:center">
    <div class="ch" style="width:100%">
      <div class="ct">Privacy Score</div>
      <button class="ib">&#9881;</button>
    </div>
    <div class="dw">
      <canvas id="chart-gauge" width="120" height="120"></canvas>
      <div class="dc"><div class="dv" id="gval">&#8212;</div><div class="dl">privacy</div></div>
    </div>
    <div class="dct" id="gmode">Run pipeline to see results</div>
    <div id="g-reliability" style="min-height:18px;text-align:center;margin-top:2px"></div>
    <div id="g-reliability-sub" class="metric-subtext"></div>
    <div class="leg">
      <div class="li"><div class="ld" style="background:var(--p4)"></div>Score</div>
      <div class="li"><div class="ld" style="background:var(--red)"></div>Risk</div>
    </div>
  </div>

  <!-- C4: Column Drift Heatmap -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Feature Drift Heatmap</div><div class="cs" id="c5sub">JS-divergence per column</div></div>
      <button class="ib">&#9881;</button>
    </div>
    <div id="c5hmap" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:0"></div>
    <div class="mvrow" style="margin-top:6px">
      <div class="mvl" id="c5l">Max Drift Column</div>
      <div class="mvv" id="c5p">&#8212;</div>
    </div>
  </div>

  <!-- C8: Pipeline Timeline -->
  <div class="card">
    <div class="ch">
      <div><div class="ct">Pipeline Timeline</div><div class="cs" id="c7s">Parse → Baseline → Generate → Leakage</div></div>
      <button class="ib">&#8942;</button>
    </div>
    <div class="timeline" id="timeline"></div>
  </div>

  <!-- C12: Dataset Risk Score -->
  <div class="card" id="c12card">
    <div class="ch">
      <div><div class="ct">Dataset Risk Score</div><div class="cs" id="c12sub">Composite governance metric</div></div>
      <button class="ib">&#9874;</button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex:1">
      <!-- Gauge circle -->
      <div style="position:relative;width:88px;height:88px;flex-shrink:0">
        <svg viewBox="0 0 88 88" style="width:88px;height:88px;transform:rotate(-90deg)">
          <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(28,28,62,.75)" stroke-width="8"/>
          <circle id="c12arc" cx="44" cy="44" r="36" fill="none" stroke="var(--red)" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="0 226" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div id="c12val" style="font-size:20px;font-weight:800;letter-spacing:-.04em">—</div>
          <div style="font-size:8px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em">/ 100</div>
        </div>
      </div>
      <!-- Breakdown -->
      <div style="flex:1;display:flex;flex-direction:column;gap:5px">
        <div id="c12badge" class="rbadge rc-unk" style="align-self:flex-start;margin-bottom:4px">—</div>
        <div id="c12breakdown" style="font-size:9px;color:var(--fg2);display:flex;flex-direction:column;gap:2px"></div>
      </div>
    </div>
    <!-- PII columns -->
    <div id="c12pii" style="font-size:9px;color:var(--fg3);line-height:1.5"></div>
  </div>

  <!-- C13: Dataset Reliability (UPGRADE 1) -->
  <div class="card" id="c13card">
    <div class="ch">
      <div><div class="ct">Dataset Reliability</div><div class="cs" id="c13sub">Statistical stability of metrics</div></div>
      <button class="ib" title="How reliable are computed metrics given the dataset size?">&#9432;</button>
    </div>
    <div style="display:flex;flex-direction:column;flex:1;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end">
        <div class="bnum" id="c13val" style="font-size:28px">—</div>
        <div id="c13badge" class="rbadge rc-unk">—</div>
      </div>
      <div class="ris-bar">
        <div class="ris-fill" id="c13fill" style="width:0%;background:var(--p4)"></div>
      </div>
      <div id="c13note" style="font-size:10px;color:var(--fg2);line-height:1.5"></div>
      <div style="font-size:9px;color:var(--fg3);margin-top:auto">Score bands: ≥500 rows=1.0 · ≥100=0.85 · ≥30=0.65 · ≥10=0.40 · &lt;10=0.15</div>
    </div>
  </div>

  <!-- C14: Dataset Intelligence Risk (Phase 3) -->
  <div class="card" id="c14card">
    <div class="ch">
      <div><div class="ct">Intelligence Risk</div><div class="cs" id="c14sub">Dataset Risk Intelligence Engine</div></div>
      <button class="ib" title="Composite risk derived from re-identification, PII density, outliers and privacy score">&#9432;</button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex:1">
      <div style="position:relative;width:88px;height:88px;flex-shrink:0">
        <svg viewBox="0 0 88 88" style="width:88px;height:88px;transform:rotate(-90deg)">
          <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(28,28,62,.75)" stroke-width="8"/>
          <circle id="c14arc" cx="44" cy="44" r="36" fill="none" stroke="var(--red)" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="0 226" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div id="c14val" style="font-size:20px;font-weight:800;letter-spacing:-.04em">—</div>
          <div style="font-size:8px;color:var(--fg3);text-transform:uppercase;letter-spacing:.07em">/ 100</div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px">
        <div id="c14badge" class="rbadge rc-unk" style="align-self:flex-start;margin-bottom:4px">—</div>
        <div id="c14breakdown" style="font-size:9px;color:var(--fg2);display:flex;flex-direction:column;gap:2px"></div>
      </div>
    </div>
  </div>

  <!-- C15: Sensitive Column Ranking (Phase 3) -->
  <div class="card" id="c15card">
    <div class="ch">
      <div><div class="ct">Sensitive Column Ranking</div><div class="cs" id="c15sub">Top columns by composite privacy risk</div></div>
      <button class="ib" title="Ranked by PII score, re-identification risk, drift and correlation">&#9432;</button>
    </div>
    <div id="c15list" style="flex:1;display:flex;flex-direction:column;gap:5px;overflow-y:auto">
      <div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>
    </div>
  </div>

  <!-- C16: Privacy Recommendations (Phase 3) -->
  <div class="card" id="c16card">
    <div class="ch">
      <div><div class="ct">Privacy Recommendations</div><div class="cs" id="c16sub">Automated mitigation guidance</div></div>
      <button class="ib" title="Rule-based recommendations from the Risk Intelligence Engine">&#9432;</button>
    </div>
    <div id="c16list" style="flex:1;display:flex;flex-direction:column;gap:4px;overflow-y:auto">
      <div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>
    </div>
  </div>

</div>   <!-- close grid -->
</div>   <!-- close pane-overview -->
`;
exports.OVERVIEW_SCRIPT = String.raw `
// ── Sanity checks ────────────────────────────────────────────────────
function renderSanityBanner(){
  if(!D.leakage){
     return;
  }
  const l=D.leakage||{};
  const warns=[];
  const dup=l.duplicates_rate, auc=l.membership_inference_auc;
  const dk=(l.statistical_drift||'').toLowerCase();
  if(dup!=null && dup>0.1) warns.push({msg:'Duplicates rate '+pct(dup)+' exceeds 10% threshold',sev:'crit'});
  else if(dup!=null && dup>0.05) warns.push({msg:'Duplicates rate '+pct(dup)+' is elevated',sev:'warn'});
  if(auc!=null && auc>0.7) warns.push({msg:'MI-AUC '+auc.toFixed(3)+' > 0.70 — HIGH membership inference risk',sev:'crit'});
  else if(auc!=null && auc>0.6) warns.push({msg:'MI-AUC '+auc.toFixed(3)+' > 0.60 — elevated inference risk',sev:'warn'});
  if(dk==='high') warns.push({msg:'Statistical drift is HIGH — distribution divergence detected',sev:'warn'});
  const b=document.getElementById('sanity-banner');
  if(!b) return;
  if(!warns.length){b.style.display='none';return;}
  const hasCrit=warns.some(w=>w.sev==='crit');
  b.className='warn-banner'+(hasCrit?' crit-banner':'');
  b.innerHTML='<b style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:'+(hasCrit?'#f87171':'#fb923c')+'">⚠ Alerts</b>'+warns.map(w=>'<span class="warn-item">'+esc(w.msg)+'</span>').join('');
  b.innerHTML='<b style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:'+(hasCrit?'#f87171':'#fb923c')+'">⚠ Alerts</b>'+warns.map(w=>'<span class="warn-item">'+esc(w.msg)+'</span>').join('');
  b.style.display='flex';
}

// ── Dataset Summary Card ─────────────────────────────────────────────
function renderDatasetSummary(){
  const b = D.profile || D.baseline || {};
  const sc = D.scanReport || {};
  const el = document.getElementById('ds-summary-body');
  if(!el) return;
  if(!b.columns){
    el.innerHTML = '<div style="color:var(--fg3);font-size:11px">Run pipeline to view summary.</div>';
    return;
  }
  
  const numRows = b.meta?.row_count_estimate ?? b.meta?.row_count ?? 0;
  const numCols = Object.keys(b.columns?.numeric || {}).length;
  const catCols = Object.keys(b.columns?.categorical || {}).length;
  const totalCols = numCols + catCols;
  
  const piiCols = new Set([
    ...(sc.high_risk_columns || []),
    ...(sc.pii_findings || []).map(f => f.column)
  ].filter(Boolean));

  el.innerHTML = [
    '<div class="mvrow"><div class="mvl">Total Rows</div><div class="mvv" style="color:var(--p5)">'+(numRows?numRows.toLocaleString():'—')+'</div></div>',
    '<div class="mvrow"><div class="mvl">Total Columns</div><div class="mvv">'+totalCols+'</div></div>',
    '<div class="mvrow"><div class="mvl">Numeric / Categorical</div><div class="mvv" style="font-size:14px">'+numCols+' <span style="color:var(--fg3);font-size:12px;font-weight:400">/</span> '+catCols+'</div></div>',
    '<div class="mvrow" style="margin-top:auto"><div class="mvl">PII Columns</div><div class="mvv" style="color:'+(piiCols.size>0?'var(--orange)':'var(--green)')+'">'+piiCols.size+'</div></div>'
  ].join('');
}

// ── Status strip ────────────────────────────────────────────────────
function renderStrip(){
  if(!D.leakage){
     return;
  }
  const l=D.leakage||{};
  // Support both D.result (pipelineComplete) and D.generator (pipelineResult spec)
  const r=D.generator||D.result||{};
  const b=D.profile||D.baseline||{};
  const mRisk=document.getElementById('m-risk'); if(mRisk) mRisk.innerHTML=rbadge(l.risk_level);

  const ps=l.privacy_score!=null?pctInt(l.privacy_score):null;
  const pe=document.getElementById('m-ps');
  if(pe){ pe.textContent=ps!=null?ps+'%':'—'; if(ps!=null) pe.style.color=ps>=75?C.green:ps>=50?C.orange:C.red; }

  const dk=(l.statistical_drift||'unknown').toLowerCase();
  const de=document.getElementById('m-drift');
  if(de){ de.textContent=dk==='unknown'?'—':dk; de.style.color=dk==='high'?C.red:dk==='moderate'?C.orange:dk==='low'?C.green:C.fg2; }

  const ue=document.getElementById('m-dup'), dup=l.duplicates_rate;
  if(ue){ ue.textContent=pct(dup); if(dup!=null) ue.style.color=dup>.05?C.orange:C.green; }

  const sr=r.row_count;
  const mr=document.getElementById('m-rows'); if(mr) mr.textContent=sr!=null?sr.toLocaleString():'—';
  const numCols=Object.keys((b.columns&&b.columns.numeric)||{});
  const catCols=Object.keys((b.columns&&b.columns.categorical)||{});
  const hs=document.getElementById('hdr-sub');
  if(hs) hs.textContent='Engine: '+(r.generator_used||'—')+(sr?' · '+sr.toLocaleString()+' rows':'')+((numCols.length+catCols.length)?' · '+(numCols.length+catCols.length)+' cols':'');
}

// ── C1: SynthDataGen ────────────────────────────────────────────────
function renderC1(){
  const r=D.generator||D.result||{}, cp=D.cp||{};
  const sr=r.row_count||0;
  const c1n=document.getElementById('c1n'); if(c1n) c1n.textContent=sr>0?sr.toLocaleString():'0';
  const c1s=document.getElementById('c1s'); if(c1s) c1s.textContent=r.generator_used?'Engine: '+r.generator_used:'Ready to generate';
  const commits=cp.commits||[];
  const el=document.getElementById('c1bars');
  if(!el) return;
  if(commits.length){
    // Real commit history from checkpoint
    const mx=Math.max(...commits.map(c=>c.n_rows||0),1);
    el.innerHTML=commits.slice(-12).map(c=>'<div class="mb" style="height:'+Math.max(6,Math.round(((c.n_rows||0)/mx)*100))+'%"></div>').join('');
  } else if(sr>0){
    // Single real bar representing the actual current run row count
    // Pad with dim placeholders on the left to fill visual space without faking data
    const dimCount=11;
    const dimBars=Array.from({length:dimCount},()=>'<div class="mb dim" style="height:20%"></div>').join('');
    el.innerHTML=dimBars+'<div class="mb hot" style="height:100%;" title="'+sr.toLocaleString()+' rows generated"></div>';
  } else {
    // No data yet — show fully greyed empty state
    el.innerHTML=Array.from({length:12},()=>'<div class="mb dim" style="height:12%"></div>').join('');
  }
}

// ── C2: Privacy Gauge ────────────────────────────────────────────────
function renderC2(){
  if(!D.leakage){
     return;
  }
  const l=D.leakage||{};
  const ps=l.privacy_score!=null?pctInt(l.privacy_score):null;
  const el=document.getElementById('gval'); if(!el) return;
  const gm=document.getElementById('gmode');
  const relEl=document.getElementById('g-reliability');
  const subEl=document.getElementById('g-reliability-sub');
  if(ps!=null){
    const gc=ps>=75?C.green:ps>=50?C.orange:C.red;
    el.textContent=ps+'%'; el.style.color=gc;
    gm.textContent=ps>=75?'✓ Good Privacy':ps>=50?'⚠ Moderate Risk':'✗ High Risk';
    gm.style.color=gc;
    // Reliability badge
    if(l.privacy_score_reliable===false){
      const notes=Array.isArray(l.uncertainty_notes)&&l.uncertainty_notes.length
        ? l.uncertainty_notes.join(' ')
        : 'Metrics unreliable: dataset too small';
      relEl.innerHTML='<span class="metric-badge badge-warning" title="'+notes.replace(/"/g,'&quot;')+'">⚠ UNRELIABLE</span>';
    } else {
      relEl.innerHTML='';
    }
    // Reliability score subtext
    const ris=l.statistical_reliability_score;
    if(ris!=null){
      const risLabel=ris<0.3?'very low':ris<0.6?'low':ris<0.8?'moderate':'high';
      subEl.textContent='Reliability: '+ris.toFixed(2)+' ('+risLabel+')';
    } else {
      subEl.textContent='';
    }
    getOrCreateChart('chart-gauge',{type:'doughnut',
      data:{datasets:[{data:[ps,100-ps],backgroundColor:[C.p4,'rgba(28,28,62,.9)'],borderWidth:0,circumference:240,rotation:240}]},
      options:{cutout:'72%',plugins:{legend:{display:false},tooltip:{enabled:false}},animation:{duration:820}}});
  } else {
    el.textContent='N/A'; el.style.color=C.fg2;
    gm.textContent=l.error?'Leakage unavailable':'No data';
    relEl.innerHTML='';
    subEl.textContent='';
  }
}


// ── C12: Dataset Risk Score ──────────────────────────────────────────
function renderC12(){
  const l=D.leakage||{};
  const drs=l.dataset_risk_score;
  const valEl=document.getElementById('c12val');
  const arcEl=document.getElementById('c12arc');
  const badgeEl=document.getElementById('c12badge');
  const brkEl=document.getElementById('c12breakdown');
  const piiEl=document.getElementById('c12pii');
  if(!valEl||!arcEl||!badgeEl||!brkEl||!piiEl) return;

  if(!D.leakage || drs==null){
    valEl.textContent='—';
    const sub=document.getElementById('c12sub');
    if(sub) sub.textContent=D.leakage?'Risk score not computed':'Run the generator to view results.';
    return;
  }

  // Arc gauge: circumference of r=36 circle = 2π*36 ≈ 226
  const circ=226;
  const fill=Math.round((drs/100)*circ);
  arcEl.setAttribute('stroke-dasharray', fill+' '+(circ-fill));
  // Color: 0-40 green, 40-70 orange, 70-100 red
  const color=drs>=70?C.red:drs>=40?C.orange:C.green;
  arcEl.setAttribute('stroke', color);

  valEl.textContent=drs.toFixed(1);
  valEl.style.color=color;

  // Badge
  const label=drs>=70?'HIGH RISK':drs>=40?'MOD RISK':'LOW RISK';
  const cls=drs>=70?'rc-crit':drs>=40?'rc-warn':'rc-low';
  badgeEl.textContent=label;
  badgeEl.className='rbadge '+cls;

  // Component breakdown (formula terms)
  const ps=l.privacy_score;
  const dup=l.duplicates_rate, ads=l.avg_drift_score;
  const terms=[
    ['Privacy',    ps!=null?((1-ps)*40).toFixed(1)+'pt':'n/a', '(1-score)×40'],
    ['Duplicates', dup!=null?(dup*20).toFixed(2)+'pt':'n/a',   'dup×20'],
    ['Drift',      ads!=null?(ads*10).toFixed(3)+'pt':'n/a',   'drift×10'],
  ];
  brkEl.innerHTML=terms.map(([name,contrib,formula])=>
    '<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(139,92,246,.1);padding-top:2px">'+
    '<span style="color:var(--fg3)">'+esc(name)+' <span style="opacity:.6">('+esc(formula)+')</span></span>'+
    '<span style="color:var(--fg2);font-weight:600">'+esc(contrib)+'</span></div>'
  ).join('');

  // PII columns
  const piiCols=(l.pii_columns||D.pii_columns||[]);
  if(piiCols.length){
    piiEl.innerHTML='<span style="color:var(--orange);font-weight:600">⚠ PII columns: </span>'+
      piiCols.map(c=>'<span class="pii-col-badge">'+esc(c)+'</span>').join(' ');
  } else {
    piiEl.textContent='No PII columns detected';
  }
}

// ── C4: Feature Drift Heatmap ─────────────────────────────────────────
function renderC5(){
  const l=D.leakage||{};
  // Support both column_drift (direct) and leakage.column_drift
  const cd=l.column_drift||{};
  const cols=Object.keys(cd);
  const hmap=document.getElementById('c5hmap'), pe=document.getElementById('c5p');
  const sub=document.getElementById('c5sub');
  if(!hmap||!pe) return;
  if(!D.leakage){
    hmap.innerHTML='<div style="padding:12px;font-size:11px;color:var(--fg3)">Run the generator to view results.</div>';
    pe.textContent='—';
    if(sub) sub.textContent='JS-divergence per column';
    return;
  }
  if(!cols.length){
    hmap.innerHTML='<div style="padding:12px;font-size:11px;color:var(--fg3)">No drift data available — all columns may be categorical or drift could not be computed.</div>';
    pe.textContent='—'; return;
  }
  // Sort descending by drift score
  const sorted=cols.slice().sort((a,b)=>(cd[b]||0)-(cd[a]||0));
  const mx=Math.max(...sorted.map(c=>cd[c]||0),0.001);
  const top=sorted[0]||'';
  pe.textContent=(cd[top]||0).toFixed(4);
  pe.style.color=(cd[top]||0)>.15?C.red:(cd[top]||0)>.05?C.orange:C.green;
  document.getElementById('c5l').textContent='Max: '+top.slice(0,18);
  sub.textContent=cols.length+' columns · JS-divergence';
  hmap.innerHTML=sorted.map(col=>{
    const v=Math.max(0,Math.min(cd[col]||0,1));
    const pct100=Math.round((v/mx)*100);
    // Color: 0→green, 0.5→yellow, 1→red
    const r=Math.round(Math.min(255,v*510)), g=Math.round(Math.min(255,(1-v)*510));
    const fill='rgb('+r+','+g+',40)';
    return '<div class="dh-row">'+
      '<div class="dh-lbl" title="'+esc(col)+'">'+esc(col)+'</div>'+
      '<div class="dh-bar-wrap"><div class="dh-bar-fill" style="width:'+pct100+'%;background:'+fill+'"></div></div>'+
      '<div class="dh-val">'+v.toFixed(3)+'</div></div>';
  }).join('');
}




// ── C8: Pipeline Timeline ────────────────────────────────────────────
function renderTimeline(){
  const r=D.generator||D.result||{}, l=D.leakage||{}, b=D.profile||D.baseline||{}, ast=D.ast||{};
  const tl=document.getElementById('timeline');
  if(!tl) return;
  // If no pipeline has been run, show a waiting placeholder
  if(!D.result && !D.generator && !D.baseline && !D.profile && !D.ast){
    tl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Run pipeline to see execution timeline.</div>';
    return;
  }
  const steps=[
    {name:'Parse',    info: ast?.dataset ? Object.keys(ast.dataset?.schema?.fields||[]).length+' columns' : (ast?.error||'skipped'), done:!!ast?.dataset},
    {name:'Baseline', info: b?.meta ? (b.meta.row_count||'?')+' rows profiled' : 'skipped',  done:!!b?.meta},
    {name:'Generate', info: r?.row_count ? r.row_count+' rows · '+r.generator_used : 'pending', done:!!r?.row_count},
    {name:'Leakage',  info: l?.risk_level ? 'risk: '+l.risk_level : (l?.error||'pending'), done:!!l?.privacy_score, fail:!!l?.error&&!l?.privacy_score},
  ];
  tl.innerHTML=steps.map(s=>{
    const cls='tl-step'+(s.fail?' fail':s.done?' done':'');
    return '<div class="'+cls+'"><div class="tl-dot"></div>'+'<span class="tl-name">'+esc(s.name)+'</span>'+'<span class="tl-info">'+esc(String(s.info))+'</span></div>';
  }).join('');
}

// ── UPGRADE 1: Statistical Reliability Indicator ──────────────────────
function renderRis(){
  const l=D.leakage||{};
  const ris=l.statistical_reliability_score;
  const valEl=document.getElementById('c13val');
  const fillEl=document.getElementById('c13fill');
  const badgeEl=document.getElementById('c13badge');
  const noteEl=document.getElementById('c13note');
  const subEl=document.getElementById('c13sub');
  if(!valEl||!fillEl||!badgeEl||!noteEl) return;
  if(ris==null){
    valEl.textContent='—';
    noteEl.textContent='Run pipeline to compute.';
    return;
  }
  const pct100=Math.round(ris*100);
  const color=ris>=0.85?C.green:ris>=0.65?C.orange:ris>=0.40?C.yellow:C.red;
  valEl.textContent=(ris*100).toFixed(0)+'%';
  valEl.style.color=color;
  fillEl.style.width=pct100+'%';
  fillEl.style.background=color;
  const label=ris>=0.85?'HIGH':ris>=0.65?'MODERATE':ris>=0.40?'LOW':'VERY LOW';
  const cls=ris>=0.85?'rc-low':ris>=0.65?'rc-warn':'rc-crit';
  badgeEl.textContent=label;
  badgeEl.className='rbadge '+cls;
  const n_samp=l.n_samples, n_num=l.num_cols_analysed, n_cat=l.cat_cols_analysed;
  const parts=[];
  if(n_num!=null||n_cat!=null) parts.push((n_num||0)+' numeric, '+(n_cat||0)+' categorical columns');
  if(n_samp!=null) parts.push(n_samp.toLocaleString()+' synthetic samples');
  if(ris<0.50) parts.push('⚠ Metrics may be statistically unstable — consider gathering more data');
  noteEl.textContent=parts.join(' · ')||'Metric stability score computed from row count.';
  if(subEl) subEl.textContent='Row-count based · '+pct100+'% stability';
}

// ── UPGRADE 2: Privacy Attack Visualization ───────────────────────────
function renderAttackGauges(){
  const l=D.leakage||{};
  const atk=l.attack_results||{};
  const circ=176; // 2π*28 ≈ 176
  const metrics=[
    {arc:'atk-arc-1',val:'atk-val-1',v:atk.membership_attack_success,baseColor:C.red},
    {arc:'atk-arc-2',val:'atk-val-2',v:atk.reconstruction_risk,baseColor:C.orange},
    {arc:'atk-arc-3',val:'atk-val-3',v:atk.nearest_neighbor_leakage,baseColor:C.p4},
  ];
  let anyData=false;
  metrics.forEach(function(m){
    const arcEl=document.getElementById(m.arc);
    const valEl=document.getElementById(m.val);
    if(!arcEl||!valEl) return;
    if(m.v==null){
      valEl.textContent='—';
      arcEl.setAttribute('stroke-dasharray','0 '+circ);
      return;
    }
    anyData=true;
    const pctV=Math.max(0,Math.min(1,m.v));
    const fill=Math.round(pctV*circ);
    const color=pctV>=0.7?C.red:pctV>=0.4?C.orange:C.green;
    arcEl.setAttribute('stroke-dasharray',fill+' '+(circ-fill));
    arcEl.setAttribute('stroke',color);
    valEl.textContent=Math.round(pctV*100)+'%';
    valEl.style.color=color;
  });
  const noteEl=document.getElementById('atk-note');
  if(noteEl){
    if(anyData){
      const mas=atk.membership_attack_success;
      noteEl.textContent=mas!=null?'Membership attack success derived from MI-AUC: '+(mas*100).toFixed(1)+'% (based on distance proxy to training set)':'Attack metrics derived from leakage analysis.';
      noteEl.style.color=mas!=null&&mas>0.5?C.orange:C.green;
    } else {
      noteEl.textContent='Run the pipeline to compute attack simulation metrics.';
    }
  }
}

// ── Phase 3: Dataset Intelligence Risk (C14) ────────────────────────
function renderIntelligenceRisk(){
  var l=D.leakage||{};
  var dir=l.dataset_intelligence_risk||{};
  var score=dir.score;
  var label=dir.label;
  var brkdn=dir.breakdown||{};
  var valEl=document.getElementById('c14val');
  var arcEl=document.getElementById('c14arc');
  var badgeEl=document.getElementById('c14badge');
  var brkEl=document.getElementById('c14breakdown');
  var subEl=document.getElementById('c14sub');
  if(!valEl) return;
  if(!D.leakage || score==null){
    valEl.textContent='—';
    arcEl&&arcEl.setAttribute('stroke-dasharray','0 226');
    badgeEl&&(badgeEl.textContent='—');
    subEl&&(subEl.textContent=D.leakage?'Risk intelligence not computed':'Run the generator to view results.');
    return;
  }
  var fill=Math.round((score/100)*226);
  var color=score>=80?C.red:score>=60?C.orange:score>=30?C.p4:C.green;
  valEl.textContent=Math.round(score);
  valEl.style.color=color;
  arcEl&&arcEl.setAttribute('stroke-dasharray',fill+' '+(226-fill));
  arcEl&&arcEl.setAttribute('stroke',color);
  var badgeMap={CRITICAL:'rc-crit',HIGH:'rc-high',MODERATE:'rc-mod',LOW:'rc-low'};
  if(badgeEl){ badgeEl.textContent=label||'—'; badgeEl.className='rbadge '+(badgeMap[label]||'rc-unk'); }
  subEl&&(subEl.textContent='Intelligence risk: '+(label||'—'));
  if(brkEl){
    var lines=[
      ['Dataset Risk', brkdn.dataset_risk_contribution],
      ['Re-ID Risk',   brkdn.reidentification_contribution],
      ['PII Density',  brkdn.pii_density_contribution],
      ['Outliers',     brkdn.outlier_contribution],
      ['Privacy Gap',  brkdn.privacy_score_contribution],
    ];
    brkEl.innerHTML=lines.map(function(row){
      if(row[1]==null) return '';
      return '<div style="display:flex;justify-content:space-between"><span>'+esc(row[0])+'</span><span>'+row[1].toFixed(1)+'</span></div>';
    }).join('');
  }
}

// ── Phase 3: Sensitive Column Ranking (C15) ─────────────────────────
function renderColumnRanking(){
  var l=D.leakage||{};
  var ranking=(l.sensitive_column_ranking||[]).slice(0,5);
  var listEl=document.getElementById('c15list');
  var subEl=document.getElementById('c15sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
    return;
  }
  if(!ranking.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No sensitive column data available.</div>';
    return;
  }
  subEl&&(subEl.textContent='Top '+ranking.length+' sensitive columns · sorted by composite score');
  var maxScore=ranking[0].score||1;
  listEl.innerHTML=ranking.map(function(item,idx){
    var pctBar=Math.round((item.score/Math.max(maxScore,0.001))*100);
    var sig=item.signals||{};
    var piiPct=Math.round((sig.pii_score||0)*100);
    var reidPct=Math.round((sig.reidentification_risk||0)*100);
    var driftPct=Math.round((sig.drift_score||0)*100);
    var color=item.score>=0.7?C.red:item.score>=0.4?C.orange:C.p4;
    return '<div style="display:flex;flex-direction:column;gap:3px;padding:5px 0;border-bottom:1px solid rgba(139,92,246,.08)">'+
      '<div style="display:flex;justify-content:space-between;align-items:center">'+
        '<span style="font-size:11px;font-weight:600;color:var(--fg)">'+(idx+1)+'. '+esc(item.column||'—')+'</span>'+
        '<span style="font-size:11px;font-weight:800;color:'+color+'">'+item.score.toFixed(2)+'</span>'+
      '</div>'+
      '<div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px">'+
        '<div style="height:4px;width:'+pctBar+'%;background:'+color+';border-radius:2px;transition:width .6s ease"></div>'+
      '</div>'+
      '<div style="display:flex;gap:8px;font-size:9px;color:var(--fg3)">'+
        '<span>PII: <span style="color:var(--fg2);font-weight:600">'+piiPct+'%</span></span>'+
        '<span>ReID: <span style="color:var(--fg2);font-weight:600">'+reidPct+'%</span></span>'+
        '<span>Drift: <span style="color:var(--fg2);font-weight:600">'+driftPct+'%</span></span>'+
      '</div>'+
    '</div>';
  }).join('');
}

// ── Phase 3: Privacy Recommendations (C16) ──────────────────────────
function renderRecommendations(){
  var l=D.leakage||{};
  var recs=((l.privacy_recommendations||{}).recommendations)||[];
  var listEl=document.getElementById('c16list');
  var subEl=document.getElementById('c16sub');
  if(!listEl) return;
  if(!D.leakage){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">Run the generator to view results.</div>';
    return;
  }
  if(!recs.length){
    listEl.innerHTML='<div style="color:var(--fg3);font-size:11px">No recommendations generated.</div>';
    return;
  }
  subEl&&(subEl.textContent=recs.length+' recommendation'+(recs.length===1?'':'s'));
  listEl.innerHTML=recs.map(function(r){
    return '<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
      '<span style="color:var(--p4);flex-shrink:0;font-size:11px">&#9656;</span>'+
      '<span style="font-size:10px;color:var(--fg2);line-height:1.4">'+esc(r)+'</span>'+
    '</div>';
  }).join('');
}
`;


/***/ }),
/* 9 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SYNTHETIC_SCRIPT = exports.SYNTHETIC_TAB_HTML = void 0;
exports.SYNTHETIC_TAB_HTML = String.raw `
<!-- TAB: Synthetic Data -->
<div id="pane-synthetic" class="tabpane">
  <div id="synthetic-root">
  <!-- Distribution Comparison (moved from Overview) -->
  <div style="padding:14px 20px 8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div>
        <span style="font-size:13px;font-weight:700;color:var(--p6)">Distribution Comparison</span>
        <span style="font-size:11px;color:var(--fg3);margin-left:8px" id="dc-sub">Original vs Synthetic</span>
      </div>
      <button class="ib" onclick="cycleDistCol()">&#8635;</button>
    </div>
    <select class="dist-sel" id="dc-col" onchange="renderDistComparison(this.value)"></select>
    <div class="cbox" style="max-height:150px"><canvas id="chart-dist"></canvas></div>
    <div class="dist-legend" style="margin-bottom:12px">
      <div class="dist-li"><div class="dist-dot" style="background:var(--p4);height:2px"></div>Original</div>
      <div class="dist-li"><div class="dist-dot" style="background:linear-gradient(90deg,var(--p2),var(--p6));height:6px;border-radius:2px"></div>Synthetic</div>
    </div>
  </div>
  <div class="preview-wrap">
    <table class="preview-table" id="preview-table">
      <thead id="preview-head"></thead>
      <tbody id="preview-body"><tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr></tbody>
    </table>
  </div>
  </div>
</div>
`;
exports.SYNTHETIC_SCRIPT = String.raw `
// ── Synthetic Data tab — sortable, copy-row, 50 rows ────────────────
let syntheticRendered=false, synthSortCol=null, synthSortAsc=true;
function _getSamples(){
  return (
    D.generator?.samples ||
    D.result?.samples ||
    D.cp?.rows ||
    []
  );
}
function renderSynthetic(forceRender){
  if(syntheticRendered&&!forceRender)return;
  console.log('[AutoMate] rendering synthetic tab');
  const root=document.getElementById('synthetic-root');
  if(!root){ console.error('missing root container'); return; }
  const pb=document.getElementById('preview-body');
  const ph=document.getElementById('preview-head');
  if(!pb){ console.error('missing root container'); return; }
  syntheticRendered=true;
  if(!D.generator && !D.result && !D.cp){
    pb.innerHTML='<tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr>';
    return;
  }
  const allSamples=_getSamples();
  console.log('[AutoMate] renderSynthetic — samples:', allSamples.length, 'force:', !!forceRender);
  let rows=allSamples.slice(0,50);
  if(!rows.length){
    pb.innerHTML='<tr><td style="padding:20px;color:var(--fg3)">Run the generator to see results</td></tr>';
    return;
  }
  if(synthSortCol&&rows[0]&&synthSortCol in rows[0]){
    const sc=synthSortCol, asc=synthSortAsc;
    rows=rows.slice().sort((a,b)=>{
      const va=a[sc]??'', vb=b[sc]??'';
      return asc?(typeof va==='number'?va-vb:String(va).localeCompare(String(vb)))
               :(typeof vb==='number'?vb-va:String(vb).localeCompare(String(va)));
    });
  }
  const cols=Object.keys(rows[0]||{});
  if(ph) ph.innerHTML='<tr>'+
    cols.map(c=>{
      const ic=synthSortCol===c?(synthSortAsc?' ▲':' ▼'):'';
      return '<th data-sortcol="'+esc(c)+'" onclick="synthSort(this.dataset.sortcol)" title="Sort by '+esc(c)+'">'+esc(c)+'<span class="sort-icon">'+ic+'</span></th>';
    }).join('')+'<th></th></tr>';
  pb.innerHTML=rows.map((r,i)=>{
    const cells=cols.map(c=>'<td>'+esc(String(r[c]??''))+'</td>').join('');
    return '<tr>'+cells+'<td><button class="copy-row-btn" data-idx="'+i+'" onclick="copyRow(+this.dataset.idx)">Copy</button></td></tr>';
  }).join('');
}
function synthSort(col){
  if(synthSortCol===col) synthSortAsc=!synthSortAsc;
  else{synthSortCol=col;synthSortAsc=true;}
  syntheticRendered=false; renderAll();
}
function copyRow(i){
  var rows=_getSamples();
  if(rows[i]) vscode.postMessage({command:'copyToClipboard',text:JSON.stringify(rows[i],null,2)});
}

// ── Computation cache ────────────────────────────────────────────────
const _cache = {};
function computeHistogram(values, bins, lo, hi){
  const key='hist_'+bins+'_'+lo+'_'+hi+'_'+values.length;
  if(_cache[key]) return _cache[key];
  const counts = new Array(bins).fill(0);
  const w = (hi - lo) || 1;
  for(let i=0;i<values.length;i++){
    const v = parseFloat(values[i]);
    if(!isFinite(v)) continue;
    const b = Math.min(bins-1, Math.max(0, Math.floor((v-lo)/w*bins)));
    counts[b]++;
  }
  _cache[key]=counts;
  return counts;
}

// ── Feature 1: Distribution Comparison ──────────────────────────────
let _distCols=[], _distIdx=0;
function initDistCols(){
  var b=D.profile||D.baseline||{};
  _distCols=Object.keys((b.columns&&b.columns.numeric)||{});
  var sel=document.getElementById('dc-col');
  if(!sel) return;
  sel.innerHTML=_distCols.map(function(c){return '<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join('');
}
function cycleDistCol(){
  _distIdx=(_distIdx+1)%Math.max(_distCols.length,1);
  var sel=document.getElementById('dc-col');
  if(sel&&_distCols[_distIdx]) sel.value=_distCols[_distIdx];
  renderDistComparison(_distCols[_distIdx]);
}
function renderDistComparison(col){
  var b=D.profile||D.baseline||{}, r=D.generator||D.result||{};
  var num=(b.columns&&b.columns.numeric)||{};
  var samples=r.samples||_getSamples();
  var numCols=Object.keys(num);
  const dcSub=document.getElementById('dc-sub');
  if(!numCols.length||!samples.length){
    if(dcSub) dcSub.textContent='Not enough data';
    return;
  }
  const c=col||numCols[0];
  const spec=num[c]; if(!spec) return;
  const lo=spec.min??0, hi=spec.max??1;
  const BINS=15;
  // Original histogram from baseline quantiles (reconstruct approximate dist)
  const qpts=[spec.min,spec.q01,spec.q05,spec.q25,spec.q50,spec.q75,spec.q95,spec.q99,spec.max].filter(v=>v!=null);
  const qlevels=[0,.01,.05,.25,.5,.75,.95,.99,1].slice(0,qpts.length);
  const origCounts=new Array(BINS).fill(0);
  // Approximate original distribution from quantile profile
  const w=(hi-lo)||1;
  for(let i=0;i<BINS;i++){
    const blo=lo+i/BINS*w, bhi=lo+(i+1)/BINS*w, bmid=(blo+bhi)/2;
    // Trapezoidal density from quantile CDF
    let density=0;
    for(let j=1;j<qpts.length;j++){
      if(qpts[j-1]<=bmid&&bmid<qpts[j]){
        density=(qlevels[j]-qlevels[j-1])/Math.max(qpts[j]-qpts[j-1],w/100);
        break;
      }
    }
    origCounts[i]=Math.round(density*samples.length/BINS*w);
  }
  // Synthetic histogram from real samples
  const synthVals=samples.map(row=>parseFloat(row[c])).filter(isFinite);
  const synthCounts=computeHistogram(synthVals,BINS,lo,hi);
  const labels=Array.from({length:BINS},(_,i)=>(lo+i/BINS*w).toFixed(2));
  if(dcSub) dcSub.textContent=c+' · '+samples.length+' synthetic rows';
  getOrCreateChart('chart-dist',{
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:'Original',data:origCounts,backgroundColor:'transparent',borderColor:C.p4,borderWidth:1.5,type:'line',fill:false,pointRadius:0,tension:.4},
        {label:'Synthetic',data:synthCounts,backgroundColor:'rgba(139,92,246,.25)',borderColor:C.p6,borderWidth:1,borderRadius:2}
      ]
    },
    options:{plugins:{legend:{display:false}},
      scales:{
        x:{display:false},
        y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:C.fg3,font:{size:8}}}
      },
      animation:{duration:500}}
  });
}
`;


/***/ }),
/* 10 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SECURITY_SCRIPT = exports.SECURITY_TAB_HTML = void 0;
exports.SECURITY_TAB_HTML = String.raw `
<!-- TAB: Security -->
<div id="pane-security" class="tabpane">
  <div id="security-root">
  <div style="padding:14px 20px">
    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin-bottom:12px">🛡️ PII & Security Scan</h3>
    <div class="sec-grid" id="sec-stats"></div>
    <div id="sec-findings" style="margin-top:8px"></div>

    <!-- UPGRADE 2: Privacy Attack Visualization -->
    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 10px">⚔️ Privacy Attack Simulation</h3>
    <p style="font-size:11px;color:var(--fg3);margin-bottom:10px">Attack metrics derived from statistical proximity analysis. Values computed from MI-AUC and distribution divergence — no separate dataset required.</p>
    <div class="atk-gauges" id="atk-gauges">
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-1" cx="36" cy="36" r="28" fill="none" stroke="var(--red)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-1">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Membership<br>Attack Success</div>
      </div>
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-2" cx="36" cy="36" r="28" fill="none" stroke="var(--orange)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-2">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Reconstruction<br>Risk</div>
      </div>
      <div class="atk-gauge">
        <div class="atk-gauge-ring" style="position:relative">
          <svg viewBox="0 0 72 72" style="width:72px;height:72px;transform:rotate(-90deg)">
            <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(28,28,62,.8)" stroke-width="7"/>
            <circle id="atk-arc-3" cx="36" cy="36" r="28" fill="none" stroke="var(--p4)" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 176" style="transition:stroke-dasharray .9s ease,stroke .4s"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div class="atk-gauge-val" id="atk-val-3">—</div>
          </div>
        </div>
        <div class="atk-gauge-lbl">Nearest-Neighbor<br>Leakage</div>
      </div>
    </div>
    <div id="atk-note" style="font-size:10px;color:var(--fg3);margin-bottom:14px">Run pipeline to compute attack metrics.</div>

    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 12px">⚔️ External Attack Simulation</h3>
    <div id="attack-results"></div>

    <h3 style="font-size:14px;font-weight:700;color:var(--p6);margin:20px 0 12px">🕸️ Knowledge Graph</h3>
    <div id="kg-entities" style="margin-bottom:8px"></div>
    <div id="kg-edges"></div>
  </div>
  </div>
</div>
`;
exports.SECURITY_SCRIPT = String.raw `
// ── Security tab rendering ───────────────────────────────────────────
let secRendered=false;
function renderSecurity(){
  if(secRendered)return;
  console.log('[AutoMate] rendering security tab');
  const root=document.getElementById('security-root');
  if(!root){ console.error('missing root container'); return; }
  secRendered=true;

  // Guard: no data yet
  const scan=D.scanReport||{};
  const statsEl=document.getElementById('sec-stats');
  const findEl=document.getElementById('sec-findings');
  if(!D.scanReport && !D.leakage){
    if(statsEl) statsEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:10px">Run the generator to view results.</div>';
    if(findEl)  findEl.innerHTML='';
    // Render attack gauges with empty state
    renderAttackGauges();
    return;
  }

  // Show PII columns from leakage if scan not available
  if(!D.scanReport && D.leakage){
    const l=D.leakage||{};
    const piiCols=(l.pii_columns||D.pii_columns||[]);
    const rs=Math.round(l.dataset_risk_score||0);
    const rsCol=rs>70?C.red:rs>30?C.orange:C.green;
    if(statsEl){
      statsEl.innerHTML=
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.orange+'">'+piiCols.length+'</div><div class="sec-stat-l">PII Columns</div></div>'+
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+rsCol+'">'+rs+'/100</div><div class="sec-stat-l">Risk Score</div></div>'+
        '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p5+'">'+(l.risk_level||'—')+'</div><div class="sec-stat-l">Risk Level</div></div>';
    }
    if(findEl){
      if(piiCols.length){
        findEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-bottom:8px">Detected PII columns from leakage analysis:</div>'+
          piiCols.map(function(c){
            return '<div class="sec-finding"><span class="sf-type" style="color:'+C.orange+'">PII</span>'+
              '<span class="sf-cat">Sensitive column — <span style="color:var(--fg3)">'+esc(c)+'</span></span>'+
              '<span class="sf-sev" style="background:rgba(251,146,60,.15);color:'+C.orange+'">detected</span></div>';
          }).join('');
      } else {
        findEl.innerHTML='<div style="color:var(--green);font-size:12px;padding:8px">No PII detected.</div>';
      }
    }
    renderAttackGauges();
    return;
  }

  // PII Scan stats
  if(scan.pii_findings||scan.secrets||scan.sensitive_content){
    const nPii=(scan.pii_findings||[]).length;
    const nSec=(scan.secrets||[]).length;
    const nSen=(scan.sensitive_content||[]).length;
    const rs=Math.round(scan.risk_score||0);
    const rsCol=rs>70?C.red:rs>30?C.orange:C.green;
    statsEl.innerHTML=
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.orange+'">'+nPii+'</div><div class="sec-stat-l">PII Findings</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.red+'">'+nSec+'</div><div class="sec-stat-l">Secrets</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p5+'">'+nSen+'</div><div class="sec-stat-l">Sensitive</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+rsCol+'">'+rs+'/100</div><div class="sec-stat-l">Risk Score</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p6+'">'+(scan.total_cells_scanned||0).toLocaleString()+'</div><div class="sec-stat-l">Cells Scanned</div></div>'+
      '<div class="sec-stat"><div class="sec-stat-v" style="color:'+C.p6+'">'+(scan.columns_scanned||0)+'</div><div class="sec-stat-l">Columns</div></div>';
    // Findings list
    const allFindings=[...(scan.pii_findings||[]),...(scan.secrets||[]),...(scan.sensitive_content||[])].slice(0,30);
    if(allFindings.length){
      findEl.innerHTML=allFindings.map(function(f){
        var sevCol=f.severity==='critical'?C.red:f.severity==='high'?C.orange:f.severity==='medium'?C.yellow:C.green;
        return '<div class="sec-finding">'+
          '<span class="sf-type" style="color:'+sevCol+'">'+esc(f.type)+'</span>'+
          '<span class="sf-cat">'+esc(f.category)+' — <span style="color:var(--fg3)">'+esc(f.column)+'</span></span>'+
          '<span class="sf-sev" style="background:'+sevCol+'22;color:'+sevCol+'">'+esc(f.severity)+'</span>'+
        '</div>';
      }).join('');
    } else {
      findEl.innerHTML='<div style="color:var(--green);font-size:12px;padding:8px">✓ No PII, secrets, or sensitive data detected.</div>';
    }
  } else {
    statsEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">PII scan not available. Run the full pipeline to scan.</div>';
    findEl.innerHTML='';
  }

  // Attack simulation
  const atk=D.attackReport||{};
  const atkEl=document.getElementById('attack-results');
  if(atk.results&&atk.results.length){
    var vulnCol=atk.overall_vulnerability==='safe'?C.green:atk.overall_vulnerability==='moderate'?C.orange:C.red;
    atkEl.innerHTML='<div style="margin-bottom:10px;font-size:12px">Overall: <span style="color:'+vulnCol+';font-weight:700;text-transform:uppercase">'+esc(atk.overall_vulnerability)+'</span> — '+esc(atk.summary)+'</div>'+
      atk.results.map(function(r){
        var ic=r.success?'❌':'✅';
        var sc=r.severity==='critical'?C.red:r.severity==='high'?C.orange:C.green;
        return '<div style="background:var(--card);border:1px solid var(--border);border-left:3px solid '+sc+';border-radius:8px;padding:10px;margin-bottom:6px">'+
          '<div style="display:flex;justify-content:space-between;align-items:center">'+
            '<span style="font-weight:600;font-size:12px">'+ic+' '+esc(r.attack_name)+'</span>'+
            '<span style="font-size:9px;color:'+sc+';text-transform:uppercase">'+esc(r.severity)+'</span>'+
          '</div>'+
          '<div style="font-size:11px;color:var(--fg2);margin-top:4px">'+esc(r.description)+'</div>'+
          '<div style="font-size:10px;color:var(--fg3);margin-top:2px">Success rate: '+(r.success_rate*100).toFixed(1)+'%</div>'+
        '</div>';
      }).join('')+
      (atk.recommendations&&atk.recommendations.length?
        '<div style="margin-top:10px;font-size:11px;color:var(--fg2)"><b>Recommendations:</b></div>'+
        atk.recommendations.map(function(r){return '<div style="font-size:11px;color:var(--fg3);padding:3px 0">💡 '+esc(r)+'</div>';}).join('')
      :'');
  } else {
    atkEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Attack simulation not available. Use Command Palette → "AutoMate: Run Attack Simulation".</div>';
  }

  // Knowledge graph
  var kg=D.knowledgeGraph||{};
  var kgEntEl=document.getElementById('kg-entities');
  var kgEdgeEl=document.getElementById('kg-edges');
  var entities=kg.entities||[];
  if(entities.length){
    kgEntEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-bottom:6px">'+kg.summary+'</div>'+
      entities.map(function(e){return '<span class="kg-entity">🏷️ '+esc(e)+'</span>';}).join('');
    var corrEdges=(kg.edges||[]).filter(function(e){return e.relationship==='correlates_with'||e.relationship==='associated_with';}).slice(0,10);
    if(corrEdges.length){
      kgEdgeEl.innerHTML='<div style="font-size:11px;color:var(--fg2);margin-top:10px;margin-bottom:6px">Key Relationships:</div>'+
        corrEdges.map(function(e){return '<div class="kg-edge">'+esc(e.source.replace('attr_',''))+' ↔ '+esc(e.target.replace('attr_',''))+' <span style="color:var(--p5)">('+esc(e.relationship)+': '+(e.weight||0).toFixed(3)+')</span></div>';}).join('');
    }
  } else {
    kgEntEl.innerHTML='<div style="color:var(--fg3);font-size:11px;padding:8px">Knowledge graph not available. Run the full pipeline.</div>';
  }

  // UPGRADE 2: Privacy Attack Gauges — from leakage.attack_results
  renderAttackGauges();
}
`;


/***/ }),
/* 11 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LIVE_SECURITY_SCRIPT = exports.LIVE_SECURITY_TAB_HTML = void 0;
exports.LIVE_SECURITY_TAB_HTML = String.raw `
<!-- TAB: Live Security (Phase 4) -->
<div id="pane-livesecurity" class="tabpane">
  <div id="livesecurity-root">
  <div class="lsec-wrap">
    <div class="lsec-header">
      <div>
        <div class="lsec-title">🔴 Live Security Monitor</div>
        <div style="font-size:10px;color:var(--fg3);margin-top:2px">Real-time alerts from workspace scanner, prompt detector &amp; dataset monitor</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="lsec-badge safe" id="lsec-badge">● MONITORING</span>
        <button class="lsec-btn" onclick="clearLiveAlerts()">Clear</button>
        <button class="lsec-btn" onclick="exportAlerts()">Export JSON</button>
      </div>
    </div>

    <!-- Live ticker -->
    <div class="lsec-ticker" id="lsec-ticker" style="display:none">
      <div class="lsec-ticker-dot"></div>
      <span id="lsec-ticker-text">Alert received</span>
    </div>

    <!-- Stats row -->
    <div class="lsec-stats">
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-total" style="color:var(--p5)">0</div><div class="lsec-stat-l">Total</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-critical" style="color:#f87171">0</div><div class="lsec-stat-l">Critical</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-high" style="color:#fb923c">0</div><div class="lsec-stat-l">High</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-blocked" style="color:#f87171">0</div><div class="lsec-stat-l">Blocked</div></div>
      <div class="lsec-stat-box"><div class="lsec-stat-n" id="ls-warned" style="color:#fbbf24">0</div><div class="lsec-stat-l">Warned</div></div>
    </div>

    <!-- Category filters -->
    <div class="lsec-filter">
      <span style="font-size:10px;color:var(--fg3);align-self:center">Filter:</span>
      <button class="lsec-chip active" onclick="setLsecFilter('all',this)">All</button>
      <button class="lsec-chip" onclick="setLsecFilter('secret_exposure',this)">🔑 Secrets</button>
      <button class="lsec-chip" onclick="setLsecFilter('pii_detected',this)">👤 PII</button>
      <button class="lsec-chip" onclick="setLsecFilter('prompt_leakage',this)">💬 Prompts</button>
      <button class="lsec-chip" onclick="setLsecFilter('dataset_risk',this)">📊 Datasets</button>
      <button class="lsec-chip" onclick="setLsecFilter('policy_violation',this)">🚫 Policies</button>
    </div>

    <!-- Alert table -->
    <div class="lsec-table-wrap">
      <table class="lsec-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Type</th>
            <th>File</th>
            <th>Line</th>
            <th>Pattern</th>
            <th>Policy</th>
            <th>Snippet</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody id="lsec-tbody">
          <tr><td colspan="8" class="lsec-empty">🟢 No alerts yet — scanner is active and monitoring your workspace.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  </div>
</div>
`;
exports.LIVE_SECURITY_SCRIPT = String.raw `
// ── Phase 4: Live Security Monitor ──────────────────────────────────────────
var _lsecAlerts = [];
var _lsecFilter = 'all';

var SEV_COL = { critical:'#f87171', high:'#fb923c', medium:'#fbbf24', low:'var(--green)' };
var CAT_ICON = {
  secret_exposure: '🔑', pii_detected: '👤',
  prompt_leakage: '💬', dataset_risk: '📊', policy_violation: '🚫'
};

function renderLiveSecurity(){
  const root=document.getElementById('livesecurity-root');
  if(!root){ console.error('missing root container'); return; }
  if(!_lsecAlerts.length){
    root.querySelector('#lsec-tbody')&&(root.querySelector('#lsec-tbody').innerHTML='<tr><td colspan="8" class="lsec-empty">🟢 No alerts yet — scanner is active and monitoring your workspace.</td></tr>');
  }
  updateLiveStats();
  rebuildLiveTable();
}

function appendLiveAlert(alert, animate){
  if(animate===undefined) animate=true;
  _lsecAlerts.unshift(alert);
  if(_lsecAlerts.length > 200) _lsecAlerts.length = 200;
  updateLiveStats();
  rebuildLiveTable();
  if(animate) {
    var tab = document.getElementById('live-sec-tab');
    if(tab && !tab.classList.contains('on')) {
      tab.style.color='#f87171';
      tab.textContent='🔴 Live Security (' + countBySev('critical','high') + ')';
    }
  }
}

function countBySev(){
  var sevs = Array.prototype.slice.call(arguments);
  return _lsecAlerts.filter(function(a){ return sevs.indexOf(a.severity)!==-1; }).length;
}

function updateLiveStats(){
  var total    = _lsecAlerts.length;
  var critical = _lsecAlerts.filter(function(a){ return a.severity==='critical'; }).length;
  var high     = _lsecAlerts.filter(function(a){ return a.severity==='high'; }).length;
  var blocked  = _lsecAlerts.filter(function(a){ return a.policyAction==='blocked'; }).length;
  var warned   = _lsecAlerts.filter(function(a){ return a.policyAction==='warned'; }).length;

  var setEl = function(id, v){ var el=document.getElementById(id); if(el) el.textContent=v; };
  setEl('ls-total', total);
  setEl('ls-critical', critical);
  setEl('ls-high', high);
  setEl('ls-blocked', blocked);
  setEl('ls-warned', warned);

  var badge = document.getElementById('lsec-badge');
  if(badge) {
    if(critical > 0) {
      badge.textContent = '● ' + critical + ' CRITICAL';
      badge.className = 'lsec-badge active';
    } else if(total > 0) {
      badge.textContent = '● ' + total + ' ALERTS';
      badge.className = 'lsec-badge active';
    } else {
      badge.textContent = '● MONITORING';
      badge.className = 'lsec-badge safe';
    }
  }
}

function rebuildLiveTable(){
  var tbody = document.getElementById('lsec-tbody');
  if(!tbody) return;

  var filtered = _lsecFilter === 'all'
    ? _lsecAlerts
    : _lsecAlerts.filter(function(a){ return a.category === _lsecFilter; });

  if(filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="lsec-empty">' +
      (_lsecFilter === 'all'
        ? '🟢 No alerts yet — scanner is active and monitoring your workspace.'
        : '🟢 No alerts in this category.') +
      '</td></tr>';
    return;
  }

  var html = filtered.slice(0, 100).map(function(a) {
    var sevCls = a.severity || 'low';
    var polCls = a.policyAction || 'logged';
    var catIcon = CAT_ICON[a.category] || '•';
    var ts = a.timestamp ? a.timestamp.slice(11,19) : '';
    var snippet = a.snippet ? esc(a.snippet.substring(0,60)) : '—';
    return '<tr>' +
      '<td><span class="lsec-sev ' + sevCls + '">' + sevCls + '</span></td>' +
      '<td style="font-size:11px;font-weight:600;color:var(--fg)">' + catIcon + ' ' + esc(a.type) + '</td>' +
      '<td style="font-size:11px;color:var(--p5)">' + esc(a.file) + '</td>' +
      '<td style="font-size:11px;color:var(--fg3);text-align:center">' + (a.line || '—') + '</td>' +
      '<td style="font-size:10px;color:var(--fg2);max-width:180px">' + esc((a.pattern||'').substring(0,60)) + '</td>' +
      '<td><span class="lsec-policy ' + polCls + '">' + polCls + '</span></td>' +
      '<td class="lsec-snippet">' + snippet + '</td>' +
      '<td style="font-size:9px;color:var(--fg3);white-space:nowrap">' + ts + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = html;
}

function setLsecFilter(cat, btn){
  _lsecFilter = cat;
  document.querySelectorAll('.lsec-chip').forEach(function(c){ c.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  rebuildLiveTable();
}

function clearLiveAlerts(){
  _lsecAlerts = [];
  updateLiveStats();
  rebuildLiveTable();
  var tab = document.getElementById('live-sec-tab');
  if(tab) { tab.style.color=''; tab.textContent='🔴 Live Security'; }
}

function exportAlerts(){
  var data = JSON.stringify(_lsecAlerts, null, 2);
  vscode.postMessage({ command: 'exportReport', report: _lsecAlerts, filename: 'live_security_alerts.json' });
}

function flashTicker(alert){
  var ticker = document.getElementById('lsec-ticker');
  var text   = document.getElementById('lsec-ticker-text');
  if(!ticker || !text) return;
  var sev = (alert.severity || '').toUpperCase();
  var icon = CAT_ICON[alert.category] || '⚠';
  text.textContent = icon + ' [' + sev + '] ' + esc(alert.type) + ' detected in ' + esc(alert.file);
  ticker.style.display = 'flex';
  clearTimeout(ticker._hideTimer);
  ticker._hideTimer = setTimeout(function(){ ticker.style.display='none'; }, 6000);
}
`;


/***/ }),
/* 12 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AGENT_SCRIPT = exports.AGENT_TAB_HTML = void 0;
exports.AGENT_TAB_HTML = String.raw `
<!-- TAB: AI Insights (Phase 5 — Agent Chat) -->
<div id="pane-aiinsights" class="tabpane">
  <div id="agent-root">
  <!-- Context status bar -->
  <div class="agent-ctx-bar">
    <div class="agent-ctx-dot" id="agent-ctx-dot"></div>
    <span id="agent-ctx-label">No dataset loaded — run the pipeline first for grounded responses</span>
    <span style="margin-left:auto;color:var(--fg3)" id="agent-model-tag"></span>
  </div>
  <!-- API key config row -->
  <div class="agent-config" id="agent-config-row">
    <label>🔑 OpenRouter API Key</label>
    <input class="agent-config-input" id="agent-api-key" type="password"
      placeholder="Paste your free OpenRouter API key here…"
      onkeydown="if(event.key==='Enter') agentSaveKey()" />
    <button class="agent-config-btn" onclick="agentSaveKey()">Save Key</button>
    <span class="agent-config-ok" id="agent-config-ok" style="display:none">✓ Key saved</span>
    <a href="https://openrouter.ai/keys" style="color:#fb923c;font-size:10px;text-decoration:underline;margin-left:4px" target="_blank">Get free key ↗</a>
  </div>
  <!-- PART 4: Primary chat interface -->
  <div class="agent-chat">
    <div id="agent-messages" class="agent-messages">
      <div class="agent-ai">👋 Hi! I'm the AutoMate AI Governance Agent. Ask me anything about your dataset — privacy risks, PII columns, drift, anonymization strategies, or GDPR compliance.<br><br>Run the pipeline first for grounded, data-specific answers.</div>
    </div>
    <div class="agent-input-row">
      <input id="agent-text" class="agent-text-input"
        placeholder="Ask about this dataset… e.g. Which column has the highest drift?"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();agentSendFromInput();}" />
      <button id="agent-send-simple" class="agent-send-simple" onclick="agentSendFromInput()">Send ↑</button>
    </div>
  </div>
  <!-- Legacy two-column layout kept for sidebar quick-actions (hidden by default, shown on wide screens) -->
  <div class="agent-layout" style="display:none" id="agent-legacy-layout">
    <div class="agent-sidebar">
      <div class="agent-sidebar-hdr">🤖 Quick Actions</div>
      <button class="aab" onclick="agentSend('Explain this dataset — structure, key columns, relationships, and risks.')"><span class="aab-icon">📋</span><span><span class="aab-label">Explain Dataset</span></span></button>
      <button class="aab" onclick="agentSend('Detect anomalies in this dataset — drift, skew, missing values, outliers.')"><span class="aab-icon">🔍</span><span><span class="aab-label">Detect Anomalies</span></span></button>
      <button class="aab" onclick="agentSend('Which columns are the riskiest and why?')"><span class="aab-icon">⚠️</span><span><span class="aab-label">Risky Columns</span></span></button>
      <button class="aab" onclick="agentSend('What columns contain PII and how should I protect them?')"><span class="aab-icon">👤</span><span><span class="aab-label">PII Protection</span></span></button>
      <button class="aab" onclick="agentSend('What are the GDPR implications of this dataset?')"><span class="aab-icon">⚖️</span><span><span class="aab-label">GDPR Analysis</span></span></button>
      <button class="aab" onclick="agentClear()" style="color:var(--fg3);margin-top:auto"><span class="aab-icon">🗑️</span><span><span class="aab-label">Clear Chat</span></span></button>
    </div>
    <div class="agent-main">
      <div class="agent-history" id="agent-history"><div class="agent-empty" id="agent-empty"><div class="agent-empty-icon">🤖</div><div class="agent-empty-title">AI Data Governance Agent</div><div class="agent-empty-sub">Ask any question about your dataset.</div></div></div>
      <div class="agent-input-area"><textarea class="agent-input" id="agent-input" rows="1" placeholder="Ask about your dataset…" onkeydown="agentKeydown(event)"></textarea><button class="agent-send-btn" id="agent-send-btn" onclick="agentSendInput()">Send ↑</button></div>
    </div>
  </div>
  </div>
</div>
`;
exports.AGENT_SCRIPT = String.raw `
// ── PART 5+6: Simple chat message helpers ───────────────────────────────
function addUserMessage(text){
  var msgs=document.getElementById('agent-messages');
  if(!msgs) return;
  var el=document.createElement('div');
  el.className='agent-user';
  el.textContent=text;
  msgs.appendChild(el);
  msgs.scrollTop=msgs.scrollHeight;
}

function addAgentMessage(text){
  var msgs=document.getElementById('agent-messages');
  if(!msgs) return;
  var el=document.createElement('div');
  el.className='agent-ai';
  el.textContent=text;
  msgs.appendChild(el);
  msgs.scrollTop=msgs.scrollHeight;
}

// PART 6: Send from the simple input bar
function agentSendFromInput(){
  var input=document.getElementById('agent-text');
  if(!input) return;
  var text=(input.value||'').trim();
  if(!text) return;
  console.log('[AutoMate] agentChat request:', text);
  addUserMessage(text);
  input.value='';
  // Show thinking indicator
  var msgs=document.getElementById('agent-messages');
  if(msgs){
    var think=document.createElement('div');
    think.className='agent-ai thinking';
    think.id='agent-thinking-msg';
    think.textContent='… thinking';
    msgs.appendChild(think);
    msgs.scrollTop=msgs.scrollHeight;
  }
  // Disable send while waiting
  var sendBtn=document.getElementById('agent-send-simple');
  if(sendBtn) sendBtn.disabled=true;
  vscode.postMessage({command:'agentChat', message:text});
}

// PART 2+5: initAgentChat — called when AI Insights tab is shown
function initAgentChat(){
  const root=document.getElementById('agent-root');
  if(!root){ console.error('missing root container'); return; }
  // Update context bar
  var dot=document.getElementById('agent-ctx-dot');
  var label=document.getElementById('agent-ctx-label');
  var row=document.getElementById('agent-config-row');
  var inp=document.getElementById('agent-api-key');
  if(dot&&label){
    var hasData=D&&(D.baseline||D.leakage||D.result||D.profile||D.generator);
    if(hasData){
      dot.className='agent-ctx-dot ok';
      var numCols=Object.keys(((D.profile||D.baseline||{}).columns&&(D.profile||D.baseline||{}).columns.numeric)||{}).length;
      var catCols=Object.keys(((D.profile||D.baseline||{}).columns&&(D.profile||D.baseline||{}).columns.categorical)||{}).length;
      var rows=(D.baseline&&D.baseline.meta&&D.baseline.meta.row_count)||(D.result&&D.result.row_count)||(D.generator&&D.generator.row_count)||'?';
      var risk=(D.leakage&&D.leakage.risk_level)||'—';
      var ps=D.leakage&&D.leakage.privacy_score!=null?Math.round(D.leakage.privacy_score*100)+'%':'—';
      label.textContent='✓ Dataset loaded — '+rows+' rows · '+(numCols+catCols)+' cols · risk: '+risk+' · privacy: '+ps;
    } else {
      dot.className='agent-ctx-dot none';
      label.textContent='No dataset loaded — run the generator first';
      var msgs=document.getElementById('agent-messages');
      if(msgs && !msgs.textContent.trim()){
        msgs.innerHTML='<div class="agent-ai">👋 Hi! I\'m the AutoMate AI Governance Agent. Run the generator first for grounded, data-specific answers.</div>';
      }
    }
  }
  // Restore saved API key
  try{
    var savedKey=localStorage.getItem('automate_api_key');
    if(savedKey){ vscode.postMessage({command:'setApiKey',apiKey:savedKey}); }
  }catch(e){}
  vscode.postMessage({command:'checkApiKey'});
  // Also init legacy sidebar layout
  if(typeof agentInitCtxBar==='function') agentInitCtxBar();
}

// ── Phase 5: AI Data Governance Agent Chat ───────────────────────────────────
var _agentHistory = [];  // {role, content, ts}
var _agentThinking = false;
var _agentMsgCounter = 0;

// ── Phase 2/3: API key save (localStorage + extension) ───────────────
function agentSaveKey(){
  var inp=document.getElementById('agent-api-key');
  if(!inp) return;
  var key=(inp.value||'').trim();
  if(!key){ inp.focus(); return; }
  // Phase 2 — persist to localStorage so it survives panel reloads
  try{ localStorage.setItem('automate_api_key', key); }catch(e){}
  // Phase 3 — send to extension so OpenRouterClient can use it immediately
  vscode.postMessage({command:'setApiKey', apiKey:key});
  // Update UI feedback
  var ok=document.getElementById('agent-config-ok');
  if(ok){ ok.style.display=''; setTimeout(function(){ ok.style.display='none'; },2500); }
  inp.value='';
  // Hide config row, re-check key status
  var row=document.getElementById('agent-config-row');
  if(row) row.style.display='none';
  var banner=document.getElementById('agent-key-banner');
  if(banner) banner.style.display='none';
  // Re-query extension so context bar updates
  vscode.postMessage({command:'checkApiKey'});
}

function agentInitCtxBar(){
  var dot   = document.getElementById('agent-ctx-dot');
  var label = document.getElementById('agent-ctx-label');
  var banner= document.getElementById('agent-key-banner');
  var row   = document.getElementById('agent-config-row');
  var inp   = document.getElementById('agent-api-key');
  if(!dot||!label) return;

  // Phase 2 — load any previously saved key from localStorage and pre-send it
  try{
    var savedKey = localStorage.getItem('automate_api_key');
    if(savedKey){
      vscode.postMessage({command:'setApiKey', apiKey:savedKey});
      if(inp) inp.placeholder='Key loaded from storage — paste new key to update';
    }
  }catch(e){}

  // Ask extension whether API key is configured
  vscode.postMessage({command:'checkApiKey'});

  // Dataset context status
  var hasData = D && (D.baseline || D.leakage || D.result);
  if(hasData){
    dot.className='agent-ctx-dot ok';
    var numCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.numeric)||{}).length;
    var catCols = Object.keys((D.baseline&&D.baseline.columns&&D.baseline.columns.categorical)||{}).length;
    var rows  = (D.baseline&&D.baseline.meta&&D.baseline.meta.row_count) || (D.result&&D.result.row_count) || '?';
    var cols  = numCols + catCols;
    var risk  = (D.leakage&&D.leakage.risk_level) || '—';
    var ps    = D.leakage&&D.leakage.privacy_score!=null ? Math.round(D.leakage.privacy_score*100)+'%' : '—';
    label.textContent = '✓ Dataset loaded — '+rows+' rows · '+cols+' cols · risk: '+risk+' · privacy: '+ps+'. Responses grounded in pipeline data.';
  } else {
    dot.className='agent-ctx-dot none';
    label.textContent = 'No dataset loaded — run the pipeline first for grounded responses';
  }
}

function agentRender(){
  agentInitCtxBar();
  var hist = document.getElementById('agent-history');
  var empty = document.getElementById('agent-empty');
  if(!hist) return;
  if(_agentHistory.length===0){
    if(empty) empty.style.display='';
    return;
  }
  if(empty) empty.style.display='none';
  // Only re-append new messages for efficiency
  var existing = hist.querySelectorAll('.agent-msg,.agent-thinking').length;
  var toRender  = _agentHistory.slice(existing);
  toRender.forEach(function(m){ hist.appendChild(agentBuildBubble(m)); });
  hist.scrollTop=hist.scrollHeight;
}

function extractCodeBlocks(text) {
  var BT = String.fromCharCode(96);
  var marker = BT + BT + BT;
  var blocks = [];
  var pos = 0;
  while (true) {
    var start = text.indexOf(marker, pos);
    if (start === -1) break;
    var end = text.indexOf(marker, start + 3);
    if (end === -1) break;
    var block = text.substring(start + 3, end).trim();
    blocks.push(block);
    pos = end + 3;
  }
  return blocks;
}

function agentBuildBubble(m){
  var wrap = document.createElement('div');
  wrap.className='agent-msg '+(m.role==='user'?'user':'assistant');
  var bubble = document.createElement('div');
  bubble.className='agent-bubble';
  var txt = m.content||'';
  var BT = String.fromCharCode(96);
  var marker = BT + BT + BT;
  // Split text into plain-text and code-block segments
  var segments = [];
  var pos = 0;
  while (true) {
    var next = txt.indexOf(marker, pos);
    if (next === -1) { segments.push({type:'text', content:txt.substring(pos)}); break; }
    if (next > pos) segments.push({type:'text', content:txt.substring(pos, next)});
    var closePos = txt.indexOf(marker, next + 3);
    if (closePos === -1) { segments.push({type:'text', content:txt.substring(next)}); break; }
    var inner = txt.substring(next + 3, closePos);
    // Detect language tag on first line
    var newline = inner.indexOf(String.fromCharCode(10));
    var lang = newline !== -1 ? inner.substring(0, newline).trim().toLowerCase() : '';
    var code = newline !== -1 ? inner.substring(newline + 1).trim() : inner.trim();
    segments.push({type:'code', lang:lang, content:code});
    pos = closePos + 3;
  }
  segments.forEach(function(seg){
    if (seg.type === 'code' && seg.lang === 'sql') {
      // Render SQL blocks with copy button
      var sqlDiv=document.createElement('div'); sqlDiv.className='agent-sql';
      sqlDiv.textContent=seg.content;
      var btn=document.createElement('button'); btn.className='agent-sql-copy'; btn.textContent='Copy';
      (function(c){ btn.onclick=function(){vscode.postMessage({command:'copyToClipboard',text:c});btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy';},1500);}; })(seg.content);
      sqlDiv.appendChild(btn);
      bubble.appendChild(sqlDiv);
    } else if (seg.type === 'code') {
      // Render generic code blocks
      var pre=document.createElement('pre'); pre.style.cssText='background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:11px;overflow-x:auto;margin:4px 0';
      pre.textContent=seg.content; bubble.appendChild(pre);
    } else if (seg.content) {
      var span=document.createElement('span'); span.textContent=seg.content; bubble.appendChild(span);
    }
  });
  var meta=document.createElement('div'); meta.className='agent-msg-meta';
  meta.textContent=(m.role==='user'?'You':'Agent')+(m.ts?' · '+m.ts:'')+(m.model?' · '+m.model:'');
  wrap.appendChild(bubble); wrap.appendChild(meta);
  return wrap;
}

function agentShowThinking(){
  var hist=document.getElementById('agent-history');
  if(!hist) return;
  var div=document.createElement('div'); div.className='agent-thinking'; div.id='agent-thinking-bubble';
  div.innerHTML='<span></span><span></span><span></span>';
  hist.appendChild(div); hist.scrollTop=hist.scrollHeight;
}
function agentHideThinking(){
  var el=document.getElementById('agent-thinking-bubble'); if(el) el.remove();
  var el2=document.getElementById('agent-thinking-msg'); if(el2) el2.remove();
}

function agentSend(text){
  var msg=(text||'').trim();
  if(!msg||_agentThinking) return;
  var input=document.getElementById('agent-input');
  if(input&&!text){ msg=input.value.trim(); if(!msg) return; input.value=''; }
  if(input&&text){ input.value=''; }
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:msg,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  var msgId='am-'+_agentMsgCounter;
  // Build clean history for backend (role + content only)
  var histPayload=_agentHistory.slice(0,-1).map(function(m){return{role:m.role,content:m.content};});
  vscode.postMessage({command:'agentChat',message:msg,history:histPayload,msgId:msgId});
}

function agentKeydown(e){
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); agentSendInput(); }
}
function agentSendInput(){
  var input=document.getElementById('agent-input');
  if(!input) return;
  agentSend(input.value);
  input.value='';
}

function agentAction(action){
  if(_agentThinking) return;
  var labels={
    explainDataset:'Explain this dataset — structure, key columns, relationships, and risks.',
    detectAnomalies:'Detect anomalies in this dataset — drift, skew, missing values, outliers.',
    suggestCleaning:'Suggest a data cleaning plan — imputation, outlier handling, PII masking.',
    recommendGovernance:'Recommend a governance action plan — masking, anonymisation, compliance.'
  };
  var displayMsg=labels[action]||action;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:displayMsg,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  var msgId='am-'+_agentMsgCounter;
  vscode.postMessage({command:'agentAction',action:action,msgId:msgId});
}

function agentSQLPrompt(){
  var q=prompt('Describe the SQL query you need:','Find all records where income > 100000');
  if(!q) return;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  _agentHistory.push({role:'user',content:'Generate SQL: '+q,ts:ts});
  var empty=document.getElementById('agent-empty'); if(empty) empty.style.display='none';
  agentRender();
  agentShowThinking();
  _agentThinking=true;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=true;
  _agentMsgCounter++;
  vscode.postMessage({command:'agentAction',action:'generateSQL',sqlQuestion:q,msgId:'am-'+_agentMsgCounter});
}

function agentHandleResponse(content, model, error){
  agentHideThinking();
  _agentThinking=false;
  var btn=document.getElementById('agent-send-btn'); if(btn) btn.disabled=false;
  var simpleBtn=document.getElementById('agent-send-simple'); if(simpleBtn) simpleBtn.disabled=false;
  var ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(error){
    // If error is about missing API key, surface the inline key input
    var isKeyError = error && (error.toLowerCase().indexOf('api key')!==-1 || error.toLowerCase().indexOf('not configured')!==-1);
    if(isKeyError){
      var row=document.getElementById('agent-config-row');
      if(row){ row.style.display=''; var inp=document.getElementById('agent-api-key'); if(inp) inp.focus(); }
      _agentHistory.push({role:'assistant',content:'🔑 No API key configured. Paste your OpenRouter key in the field above to enable AI responses.',ts:ts});
      addAgentMessage('🔑 No API key configured. Paste your OpenRouter key in the field above to enable AI responses.');
    } else {
      _agentHistory.push({role:'assistant',content:'⚠ Error: '+error,ts:ts});
      addAgentMessage('⚠ Error: '+error);
    }
  } else {
    _agentHistory.push({role:'assistant',content:content||'No response.',ts:ts,model:model});
    var tag=document.getElementById('agent-model-tag'); if(tag) tag.textContent=model||'';
    addAgentMessage(content||'No response.');
  }
  agentRender();
  console.log("[AutoMate] model response received");
}

function agentClear(){
  _agentHistory=[];
  var hist=document.getElementById('agent-history');
  if(hist){
    hist.innerHTML='';
    var emptyDiv=document.createElement('div'); emptyDiv.className='agent-empty'; emptyDiv.id='agent-empty';
    emptyDiv.innerHTML='<div class="agent-empty-icon">🤖</div><div class="agent-empty-title">AI Data Governance Agent</div><div class="agent-empty-sub">Ask any question about your dataset — privacy risks, SQL generation, anomalies, cleaning strategies, or governance actions.<br><br>Responses are grounded in real pipeline metrics.</div>';
    hist.appendChild(emptyDiv);
  }
}

// Legacy fallback for old askAI (non-chat path)
function askAI(){
  var q=document.getElementById('ai-question');
  if(q) agentSend(q.value);
}
function askQuick(q){ agentSend(q); }
`;


/***/ }),
/* 13 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * realtime_scanner.ts — Phase 4: Real-Time VS Code Document Scanner
 *
 * Phase 4 additions (additive-only — existing diagnostics/decorations intact):
 *   • Pushes structured SecurityAlert objects to alert_store on every finding.
 *   • Applies policy_engine decisions (block/warn/log) per pattern match.
 *   • Monitors dataset files (.csv, .json, .parquet, .xlsx) on open/save
 *     and triggers PII density summary notifications.
 *   • Emits REAL structured alert JSON — never placeholder data.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activateRealtimeScanner = activateRealtimeScanner;
exports.deactivateRealtimeScanner = deactivateRealtimeScanner;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(3));
const alert_store_1 = __webpack_require__(14);
const policy_engine_1 = __webpack_require__(15);
const SECURITY_PATTERNS = [
    {
        name: 'OpenAI API Key',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible OpenAI API key detected. Do not commit secrets to source control.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'GitHub Token',
        regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible GitHub token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'AWS Access Key',
        regex: /\bAKIA[0-9A-Z]{16}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible AWS Access Key ID detected.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Generic API Key Assignment',
        regex: /(?:api[_-]?key|apikey|api_secret|secret_key)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/gi,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Possible API key/secret assignment detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'JWT Token',
        regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible JWT token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Private Key',
        regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Private key header detected! This is extremely sensitive.',
        category: 'secret',
        alertSeverity: 'critical',
    },
    {
        name: 'Password Assignment',
        regex: /(?:password|passwd|pwd)\s*[=:]\s*["']([^\s"']{8,})["']/gi,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible hardcoded password detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Bearer Token',
        regex: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/g,
        severity: vscode.DiagnosticSeverity.Warning,
        message: '⚠ Possible Bearer token detected.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Connection String',
        regex: /(?:mongodb|mysql|postgres|redis|amqp):\/\/[^\s"']+/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Database connection string detected. May contain credentials.',
        category: 'secret',
        alertSeverity: 'high',
    },
    {
        name: 'Email Address',
        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
        severity: vscode.DiagnosticSeverity.Information,
        message: 'ℹ Email address detected in code.',
        category: 'pii',
        alertSeverity: 'medium',
    },
    {
        name: 'SSN Pattern',
        regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ SSN-like pattern detected! This is highly sensitive PII.',
        category: 'pii',
        alertSeverity: 'critical',
    },
    {
        name: 'Credit Card',
        regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        severity: vscode.DiagnosticSeverity.Error,
        message: '⚠ Credit card number pattern detected!',
        category: 'pii',
        alertSeverity: 'critical',
    },
];
// ─────────────────────────────────────────────────────────────────────────────
// Decoration types (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const secretDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: '3px',
    after: { contentText: ' ⚠ SECRET', color: '#f87171', fontStyle: 'italic', margin: '0 0 0 8px' }
});
const piiDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    border: '1px solid rgba(251, 191, 36, 0.3)',
    borderRadius: '3px',
    after: { contentText: ' ℹ PII', color: '#fbbf24', fontStyle: 'italic', margin: '0 0 0 8px' }
});
// ─────────────────────────────────────────────────────────────────────────────
// Dataset file extensions
// ─────────────────────────────────────────────────────────────────────────────
const DATASET_EXTENSIONS = new Set(['.csv', '.json', '.parquet', '.xlsx', '.tsv', '.jsonl']);
function isDatasetFile(filePath) {
    return DATASET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
// ─────────────────────────────────────────────────────────────────────────────
// Policy notification helper
// ─────────────────────────────────────────────────────────────────────────────
function applyPolicyNotification(action, message) {
    if (action === 'block') {
        vscode.window.showErrorMessage(`AutoMate Security: ${message}`);
    }
    else if (action === 'warn') {
        vscode.window.showWarningMessage(`AutoMate Security: ${message}`);
    }
    // 'log' → silent, stored in alert_store only
}
// ─────────────────────────────────────────────────────────────────────────────
// Core scanner
// ─────────────────────────────────────────────────────────────────────────────
const diagnosticCollection = vscode.languages.createDiagnosticCollection('automate-security');
// Dedup set — prevents re-alerting same (file+line+pattern) on debounce
const _alertedKeys = new Set();
function scanDocument(document, extensionPath) {
    const diagnostics = [];
    const secretRanges = [];
    const piiRanges = [];
    if (document.lineCount > 10_000) {
        return { diagnostics, secretRanges, piiRanges, findingCount: 0 };
    }
    const text = document.getText();
    const fileLabel = path.basename(document.fileName);
    for (const pattern of SECURITY_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(text)) !== null) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            const range = new vscode.Range(startPos, endPos);
            const lineNum = startPos.line + 1;
            // VS Code diagnostic (unchanged behaviour)
            const diagnostic = new vscode.Diagnostic(range, `[AutoMate Security] ${pattern.message}`, pattern.severity);
            diagnostic.source = 'AutoMate';
            diagnostic.code = pattern.name;
            diagnostics.push(diagnostic);
            if (pattern.category === 'secret') {
                secretRanges.push(range);
            }
            else if (pattern.category === 'pii') {
                piiRanges.push(range);
            }
            // ── Phase 4: alert_store integration ──────────────────────────
            const dedupeKey = `${document.uri.fsPath}|${lineNum}|${pattern.name}`;
            if (!_alertedKeys.has(dedupeKey)) {
                _alertedKeys.add(dedupeKey);
                const decision = (0, policy_engine_1.evaluate)(pattern.name, extensionPath);
                const snippet = match[0].substring(0, 80);
                const alert = (0, alert_store_1.makeAlert)(pattern.name, decision?.severity ?? pattern.alertSeverity, pattern.category === 'secret' ? 'secret_exposure' : 'pii_detected', fileLabel, pattern.message.replace(/^[⚠ℹ]+\s*/, ''), { line: lineNum, snippet, policyAction: decision?.action });
                (0, alert_store_1.pushAlert)(alert);
                if (decision) {
                    applyPolicyNotification(decision.action, decision.message);
                }
            }
        }
    }
    return { diagnostics, secretRanges, piiRanges, findingCount: diagnostics.length };
}
function updateDecorations(editor, result) {
    editor.setDecorations(secretDecorationType, result.secretRanges);
    editor.setDecorations(piiDecorationType, result.piiRanges);
}
// ─────────────────────────────────────────────────────────────────────────────
// Dataset file monitor
// ─────────────────────────────────────────────────────────────────────────────
const PII_HEADER_PATTERNS = [
    /\bemail\b/, /\bphone\b/, /\bssn\b/, /\bsocial.?security\b/,
    /\bpassword\b/, /\bcredit.?card\b/, /\bcard.?number\b/,
    /\bdate.?of.?birth\b/, /\bdob\b/, /\baddress\b/,
    /\bip.?address\b/, /\bpassport\b/, /\bnational.?id\b/,
    /\bmedical\b/, /\bdiagnosis\b/, /\bprescription\b/,
];
async function monitorDatasetFile(document, extensionPath) {
    const fileName = path.basename(document.fileName);
    const ext = path.extname(document.fileName).toLowerCase();
    // Audit log
    (0, alert_store_1.pushAlert)((0, alert_store_1.makeAlert)('Dataset file opened', 'low', 'dataset_risk', fileName, `${ext.toUpperCase().slice(1)} dataset opened — logged for audit`, { policyAction: 'logged' }));
    // Quick heuristic header scan (first 4 KB)
    const sample = document.getText().substring(0, 4096).toLowerCase();
    const matched = PII_HEADER_PATTERNS.filter(p => p.test(sample));
    if (matched.length === 0) {
        return;
    }
    const piiDensity = matched.length / PII_HEADER_PATTERNS.length;
    const riskScore = Math.min(100, matched.length * 8);
    const riskLabel = riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MODERATE' : 'LOW';
    const topCol = sample.match(matched[0])?.[0]?.replace(/[^a-z_]/g, '') ?? 'unknown';
    const summaryMsg = `Dataset Risk: ${riskLabel} | PII Signals: ${matched.length} | Top: ${topCol}`;
    (0, alert_store_1.pushAlert)((0, alert_store_1.makeAlert)('Dataset PII signal', riskScore >= 70 ? 'high' : 'medium', 'dataset_risk', fileName, summaryMsg, { policyAction: 'warned' }));
    const decision = (0, policy_engine_1.evaluateDataset)(piiDensity, riskScore, extensionPath);
    if (decision) {
        applyPolicyNotification(decision.action, `${summaryMsg} — ${decision.message}`);
    }
    else {
        vscode.window.showInformationMessage(`📊 AutoMate — ${summaryMsg}. Run "AutoMate: Scan Dataset for PII" for a full report.`);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API (interface identical to Phase 3 — extension.ts unchanged)
// ─────────────────────────────────────────────────────────────────────────────
let debounceTimer;
let _extensionPath;
function activateRealtimeScanner(context) {
    _extensionPath = context.extensionPath;
    _alertedKeys.clear();
    if (vscode.window.activeTextEditor) {
        const result = scanDocument(vscode.window.activeTextEditor.document, _extensionPath);
        diagnosticCollection.set(vscode.window.activeTextEditor.document.uri, result.diagnostics);
        updateDecorations(vscode.window.activeTextEditor, result);
    }
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) {
            return;
        }
        if (isDatasetFile(editor.document.fileName)) {
            monitorDatasetFile(editor.document, _extensionPath);
        }
        const result = scanDocument(editor.document, _extensionPath);
        diagnosticCollection.set(editor.document.uri, result.diagnostics);
        updateDecorations(editor, result);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                const result = scanDocument(editor.document, _extensionPath);
                diagnosticCollection.set(editor.document.uri, result.diagnostics);
                updateDecorations(editor, result);
                const criticals = result.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                if (criticals.length > 0) {
                    vscode.window.setStatusBarMessage(`⚠ AutoMate: ${criticals.length} security finding(s)`, 5000);
                }
            }
        }, 800);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        const result = scanDocument(document, _extensionPath);
        diagnosticCollection.set(document.uri, result.diagnostics);
        if (isDatasetFile(document.fileName)) {
            monitorDatasetFile(document, _extensionPath);
        }
        if (result.findingCount > 0) {
            const criticals = result.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
            if (criticals > 0) {
                vscode.window.showWarningMessage(`AutoMate Security: ${criticals} critical finding(s) in ${path.basename(document.fileName)}. Review the Problems panel.`);
            }
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (isDatasetFile(document.fileName)) {
            monitorDatasetFile(document, _extensionPath);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
        diagnosticCollection.delete(document.uri);
    }));
    context.subscriptions.push(diagnosticCollection);
}
function deactivateRealtimeScanner() {
    diagnosticCollection.clear();
    diagnosticCollection.dispose();
    _alertedKeys.clear();
}


/***/ }),
/* 14 */
/***/ ((__unused_webpack_module, exports) => {


/**
 * alert_store.ts — Shared in-memory alert registry for AutoMate Phase 4
 *
 * Acts as the single source of truth for all live security alerts detected
 * by the realtime scanner, prompt scanner, and dataset monitor.
 *
 * Consumers (extension.ts, monitorPanel, openrouter_client) read from here.
 * Producers (realtime_scanner, prompt_scanner) write to here.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.onAlert = onAlert;
exports.pushAlert = pushAlert;
exports.getAlerts = getAlerts;
exports.getRecentAlerts = getRecentAlerts;
exports.clearAlerts = clearAlerts;
exports.makeAlert = makeAlert;
// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum alerts kept in memory (circular buffer) */
const MAX_ALERTS = 200;
let _alerts = [];
const _listeners = [];
/** Subscribe to new alerts. Returns an unsubscribe function. */
function onAlert(listener) {
    _listeners.push(listener);
    return () => {
        const idx = _listeners.indexOf(listener);
        if (idx !== -1) {
            _listeners.splice(idx, 1);
        }
    };
}
/** Push a new alert into the store and notify all listeners. */
function pushAlert(alert) {
    _alerts.unshift(alert); // newest first
    if (_alerts.length > MAX_ALERTS) {
        _alerts.length = MAX_ALERTS; // trim tail
    }
    _listeners.forEach(fn => {
        try {
            fn(alert);
        }
        catch { /* listener errors must not break producer */ }
    });
}
/** Return a snapshot of current alerts (newest first). */
function getAlerts() {
    return [..._alerts];
}
/** Return the N most recent alerts. */
function getRecentAlerts(n = 50) {
    return _alerts.slice(0, n);
}
/** Clear all stored alerts (e.g. on workspace reset). */
function clearAlerts() {
    _alerts = [];
}
// ─────────────────────────────────────────────────────────────────────────────
// Helper — create a well-formed alert
// ─────────────────────────────────────────────────────────────────────────────
let _counter = 0;
function makeAlert(type, severity, category, file, pattern, opts = {}) {
    _counter++;
    return {
        id: `sa-${Date.now()}-${_counter}`,
        type,
        severity,
        category,
        file,
        pattern,
        timestamp: new Date().toISOString(),
        ...opts,
    };
}


/***/ }),
/* 15 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * policy_engine.ts — Phase 4 Policy Enforcement Engine
 *
 * Reads policy.yaml (or falls back to hardcoded defaults) and maps each
 * security pattern match → enforcement action (block / warn / log).
 *
 * Design rules:
 *  - NEVER breaks if policy.yaml is missing or malformed.
 *  - All actions are additive: block always implies warn + log.
 *  - Public API is synchronous to keep the hot scanner path fast.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.refreshPolicy = refreshPolicy;
exports.evaluate = evaluate;
exports.evaluateDataset = evaluateDataset;
exports.evaluatePrompt = evaluatePrompt;
exports.getThresholds = getThresholds;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(4));
const path = __importStar(__webpack_require__(3));
// ─────────────────────────────────────────────────────────────────────────────
// Built-in defaults (used when policy.yaml is absent)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
    rules: {
        block_private_keys: { enabled: true, action: 'block', severity: 'critical', description: 'Private keys must never appear in workspace.' },
        block_aws_keys: { enabled: true, action: 'block', severity: 'critical', description: 'AWS Access Key IDs expose cloud credentials.' },
        block_credit_cards: { enabled: true, action: 'block', severity: 'critical', description: 'Credit card numbers are PCI-DSS regulated.' },
        block_connection_strings: { enabled: true, action: 'block', severity: 'high', description: 'Connection strings may embed credentials.' },
        warn_on_api_keys: { enabled: true, action: 'warn', severity: 'high', description: 'Hard-coded API keys violate secret management.' },
        warn_on_openai_keys: { enabled: true, action: 'warn', severity: 'high', description: 'OpenAI keys expose paid-API access.' },
        warn_on_jwt: { enabled: true, action: 'warn', severity: 'high', description: 'JWT tokens grant protected service access.' },
        warn_on_password: { enabled: true, action: 'warn', severity: 'high', description: 'Hardcoded passwords violate security policy.' },
        warn_on_bearer_token: { enabled: true, action: 'warn', severity: 'high', description: 'Bearer tokens grant delegated API access.' },
        warn_on_github_token: { enabled: true, action: 'warn', severity: 'high', description: 'GitHub tokens expose repository access.' },
        warn_on_ssn: { enabled: true, action: 'block', severity: 'critical', description: 'SSNs are the highest-risk PII category.' },
        warn_on_email: { enabled: true, action: 'warn', severity: 'medium', description: 'Email addresses may indicate PII exposure.' },
        warn_on_prompt_pii: { enabled: true, action: 'warn', severity: 'medium', description: 'PII in LLM prompt — anonymize before sending.' },
        warn_on_prompt_secrets: { enabled: true, action: 'block', severity: 'critical', description: 'Secrets in LLM prompts risk third-party exposure.' },
        warn_on_prompt_medical: { enabled: true, action: 'warn', severity: 'high', description: 'Medical data in prompts may violate HIPAA.' },
        warn_on_high_risk_dataset: { enabled: true, action: 'warn', severity: 'high', description: 'High-risk dataset requires privacy review.' },
        log_dataset_open: { enabled: true, action: 'log', severity: 'low', description: 'Dataset file opened — logged for audit.' },
    },
    thresholds: {
        pii_density_warn: 0.40,
        pii_density_block: 0.70,
        dataset_risk_score_warn: 60,
        prompt_pii_max_items: 0,
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Pattern → ruleId mapping
// Maps the pattern name from realtime_scanner to the relevant policy rule key.
// ─────────────────────────────────────────────────────────────────────────────
const PATTERN_TO_RULE = {
    'OpenAI API Key': 'warn_on_openai_keys',
    'GitHub Token': 'warn_on_github_token',
    'AWS Access Key': 'block_aws_keys',
    'Generic API Key Assignment': 'warn_on_api_keys',
    'JWT Token': 'warn_on_jwt',
    'Private Key': 'block_private_keys',
    'Password Assignment': 'warn_on_password',
    'Bearer Token': 'warn_on_bearer_token',
    'Connection String': 'block_connection_strings',
    'Email Address': 'warn_on_email',
    'SSN Pattern': 'warn_on_ssn',
    'Credit Card': 'block_credit_cards',
};
// ─────────────────────────────────────────────────────────────────────────────
// Policy loader
// ─────────────────────────────────────────────────────────────────────────────
let _policy = DEFAULT_POLICY;
let _policyLoadedAt = 0;
const POLICY_TTL_MS = 30_000; // reload at most every 30 s
function findPolicyFile(extensionPath) {
    // Check workspace root first, then extension dir
    const candidates = [];
    const wsRoots = vscode.workspace.workspaceFolders?.map(w => w.uri.fsPath) ?? [];
    for (const root of wsRoots) {
        candidates.push(path.join(root, 'policy.yaml'));
    }
    if (extensionPath) {
        candidates.push(path.join(extensionPath, 'policy.yaml'));
    }
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}
/**
 * Simple YAML→object parser for the limited policy.yaml schema.
 * Avoids pulling in a YAML dependency — handles only key: value pairs
 * and nested sections separated by blank lines.
 */
function parseSimpleYaml(text) {
    const result = {};
    let section = null;
    let subSection = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) {
            continue;
        }
        // Detect top-level key (no leading spaces)
        const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (topMatch) {
            section = topMatch[1];
            subSection = null;
            if (topMatch[2].trim()) {
                result[section] = coerce(topMatch[2].trim());
            }
            else {
                result[section] = result[section] ?? {};
            }
            continue;
        }
        // Detect 2-space indented key (sub-section)
        const sub2Match = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (sub2Match && section) {
            subSection = sub2Match[1];
            if (typeof result[section] !== 'object') {
                result[section] = {};
            }
            if (sub2Match[2].trim()) {
                result[section][subSection] = coerce(sub2Match[2].trim());
            }
            else {
                result[section][subSection] = result[section][subSection] ?? {};
            }
            continue;
        }
        // Detect 4-space indented key (leaf values)
        const leaf4Match = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (leaf4Match && section && subSection) {
            const key = leaf4Match[1];
            const val = coerce(leaf4Match[2].trim());
            if (typeof result[section][subSection] !== 'object') {
                result[section][subSection] = {};
            }
            result[section][subSection][key] = val;
        }
    }
    return result;
}
function coerce(v) {
    if (v === 'true') {
        return true;
    }
    if (v === 'false') {
        return false;
    }
    const n = Number(v);
    if (!isNaN(n) && v !== '') {
        return n;
    }
    // Strip surrounding quotes
    return v.replace(/^["']|["']$/g, '');
}
function buildPolicyFromYaml(raw) {
    const rules = { ...DEFAULT_POLICY.rules };
    const rawRules = raw['rules'] ?? {};
    for (const [id, ruleRaw] of Object.entries(rawRules)) {
        if (!ruleRaw || typeof ruleRaw !== 'object') {
            continue;
        }
        const r = ruleRaw;
        rules[id] = {
            enabled: r['enabled'] ?? true,
            action: (r['action'] ?? 'warn'),
            severity: (r['severity'] ?? 'medium'),
            description: r['description'] ?? '',
        };
    }
    const rawThr = raw['thresholds'] ?? {};
    const thresholds = {
        pii_density_warn: Number(rawThr['pii_density_warn'] ?? DEFAULT_POLICY.thresholds.pii_density_warn),
        pii_density_block: Number(rawThr['pii_density_block'] ?? DEFAULT_POLICY.thresholds.pii_density_block),
        dataset_risk_score_warn: Number(rawThr['dataset_risk_score_warn'] ?? DEFAULT_POLICY.thresholds.dataset_risk_score_warn),
        prompt_pii_max_items: Number(rawThr['prompt_pii_max_items'] ?? DEFAULT_POLICY.thresholds.prompt_pii_max_items),
    };
    return { rules, thresholds };
}
function loadPolicy(extensionPath) {
    const now = Date.now();
    if (now - _policyLoadedAt < POLICY_TTL_MS) {
        return _policy;
    }
    _policyLoadedAt = now;
    const filePath = findPolicyFile(extensionPath);
    if (!filePath) {
        return DEFAULT_POLICY;
    }
    try {
        const text = fs.readFileSync(filePath, 'utf-8');
        const raw = parseSimpleYaml(text);
        _policy = buildPolicyFromYaml(raw);
    }
    catch {
        _policy = DEFAULT_POLICY; // graceful fallback
    }
    return _policy;
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/** Reload the policy immediately (bypasses TTL cache). */
function refreshPolicy(extensionPath) {
    _policyLoadedAt = 0;
    loadPolicy(extensionPath);
}
/**
 * Evaluate what action should be taken for a detected pattern.
 *
 * @param patternName  The `name` field from SECURITY_PATTERNS in realtime_scanner
 * @param extensionPath  Extension root (for locating policy.yaml)
 * @returns PolicyDecision or null if the rule is disabled.
 */
function evaluate(patternName, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const ruleId = PATTERN_TO_RULE[patternName];
    if (!ruleId) {
        return null;
    }
    const rule = policy.rules[ruleId];
    if (!rule || !rule.enabled) {
        return null;
    }
    const emoji = rule.action === 'block' ? '❌' : rule.action === 'warn' ? '⚠' : 'ℹ';
    const label = rule.action === 'block' ? 'blocked by policy' : rule.action === 'warn' ? 'policy warning' : 'logged by policy';
    return {
        action: rule.action,
        severity: rule.severity,
        ruleId,
        message: `${emoji} ${patternName} — ${label}: ${rule.description}`,
    };
}
/**
 * Evaluate a dataset risk result against thresholds.
 * Returns a PolicyDecision or null if no threshold is breached.
 */
function evaluateDataset(piiDensity, riskScore, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const thr = policy.thresholds;
    if (piiDensity >= thr.pii_density_block) {
        return {
            action: 'block',
            severity: 'critical',
            ruleId: 'warn_on_high_risk_dataset',
            message: `❌ Dataset PII density ${(piiDensity * 100).toFixed(0)}% exceeds block threshold — blocked by policy`,
        };
    }
    if (piiDensity >= thr.pii_density_warn || riskScore >= thr.dataset_risk_score_warn) {
        const rule = policy.rules['warn_on_high_risk_dataset'];
        if (!rule?.enabled) {
            return null;
        }
        return {
            action: 'warn',
            severity: 'high',
            ruleId: 'warn_on_high_risk_dataset',
            message: `⚠ Dataset risk score ${riskScore.toFixed(0)}/100 — policy warning: review before use`,
        };
    }
    return null;
}
/**
 * Evaluate a prompt scan result.
 * Returns a PolicyDecision or null if clean.
 */
function evaluatePrompt(hasCritical, hasHigh, itemCount, extensionPath) {
    const policy = loadPolicy(extensionPath);
    if (hasCritical) {
        const rule = policy.rules['warn_on_prompt_secrets'];
        if (rule?.enabled) {
            return {
                action: 'block',
                severity: 'critical',
                ruleId: 'warn_on_prompt_secrets',
                message: `❌ Secrets detected in LLM prompt — blocked by policy: ${rule.description}`,
            };
        }
    }
    if (hasHigh || itemCount > policy.thresholds.prompt_pii_max_items) {
        const rule = policy.rules['warn_on_prompt_pii'];
        if (rule?.enabled) {
            return {
                action: 'warn',
                severity: 'medium',
                ruleId: 'warn_on_prompt_pii',
                message: `⚠ ${itemCount} sensitive item(s) in LLM prompt — policy warning: ${rule.description}`,
            };
        }
    }
    return null;
}
/** Expose thresholds (for dataset monitor). */
function getThresholds(extensionPath) {
    return loadPolicy(extensionPath).thresholds;
}


/***/ }),
/* 16 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


/**
 * prompt_scanner.ts — Phase 4: Prompt Leakage Detection
 *
 * Phase 4 additions (additive-only):
 *   • pushAlert() integration — every prompt scan finding creates a SecurityAlert.
 *   • evaluatePrompt() from policy_engine — blocks or warns per policy rules.
 *   • Structured findings emitted for LLM context injection.
 *
 * Core scanning logic is unchanged from Phase 3.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.scanPrompt = scanPrompt;
const alert_store_1 = __webpack_require__(14);
const policy_engine_1 = __webpack_require__(15);
const PROMPT_PATTERNS = [
    // PII
    {
        name: 'Email',
        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
        type: 'pii', category: 'email', severity: 'high',
        replaceFn: (_m, i) => `EMAIL_${String(i).padStart(3, '0')}@redacted.com`
    },
    {
        name: 'Phone',
        regex: /\b(?:\+?1[-.\ ]?)?\(?\d{3}\)?[-.\ ]?\d{3}[-.\ ]?\d{4}\b/g,
        type: 'pii', category: 'phone', severity: 'high',
        replaceFn: (_m, i) => `PHONE_${String(i).padStart(3, '0')}`
    },
    {
        name: 'SSN',
        regex: /\b\d{3}[-\ ]\d{2}[-\ ]\d{4}\b/g,
        type: 'pii', category: 'ssn', severity: 'critical',
        replaceFn: () => `SSN_REDACTED`
    },
    {
        name: 'Credit Card',
        regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        type: 'pii', category: 'credit_card', severity: 'critical',
        replaceFn: () => `CC_REDACTED`
    },
    {
        name: 'Date of Birth',
        regex: /\b(?:born|dob|date\s*of\s*birth)\s*[:=]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi,
        type: 'pii', category: 'dob', severity: 'high',
        replaceFn: () => `DOB_REDACTED`
    },
    // Medical
    {
        name: 'Medical Diagnosis',
        regex: /\b(?:diagnosed?\s+with|diagnosis\s*[:=]?\s*)\s*[A-Za-z\s]{3,40}/gi,
        type: 'medical', category: 'diagnosis', severity: 'critical',
        replaceFn: () => `MEDICAL_DIAGNOSIS_REDACTED`
    },
    {
        name: 'Prescription',
        regex: /\b(?:prescription|prescribed|medication|rx)\s*[:=]?\s*[A-Za-z\s]{3,30}/gi,
        type: 'medical', category: 'prescription', severity: 'high',
        replaceFn: () => `PRESCRIPTION_REDACTED`
    },
    {
        name: 'Patient ID',
        regex: /\b(?:patient\s*(?:id|number|no))\s*[:=]?\s*[A-Za-z0-9\-]{4,20}/gi,
        type: 'medical', category: 'patient_id', severity: 'critical',
        replaceFn: (_m, i) => `PATIENT_${String(i).padStart(3, '0')}`
    },
    {
        name: 'ICD Code',
        regex: /\bICD[-\s]?\d{1,2}[-\s]?[A-Z]\d{1,2}(?:\.\d{1,2})?\b/gi,
        type: 'medical', category: 'icd_code', severity: 'high',
        replaceFn: () => `ICD_CODE_REDACTED`
    },
    // Secrets
    {
        name: 'API Key',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `API_KEY_REDACTED`
    },
    {
        name: 'Bearer Token',
        regex: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/g,
        type: 'secret', category: 'bearer_token', severity: 'critical',
        replaceFn: () => `BEARER_TOKEN_REDACTED`
    },
    {
        name: 'AWS Key',
        regex: /\bAKIA[0-9A-Z]{16}\b/g,
        type: 'secret', category: 'aws_key', severity: 'critical',
        replaceFn: () => `AWS_KEY_REDACTED`
    },
    // Confidential
    {
        name: 'Confidential Marker',
        regex: /\b(?:confidential|classified|top\s+secret|internal\s+only|restricted|proprietary)\b/gi,
        type: 'confidential', category: 'classification', severity: 'medium',
        replaceFn: (m) => `[${m.toUpperCase()}_CONTENT_REDACTED]`
    },
];
// ─────────────────────────────────────────────────────────────────────────────
// Name detection heuristic (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const COMMON_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
    'our', 'out', 'day', 'had', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old',
    'see', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'this', 'that',
    'with', 'have', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will',
    'other', 'about', 'many', 'then', 'them', 'would', 'make', 'like', 'time', 'just',
    'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'than',
    'first', 'call', 'after', 'water', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'June',
    'July', 'August', 'September', 'October', 'November', 'December', 'Data', 'The',
    'This', 'What', 'When', 'Where', 'Why', 'How', 'Please', 'Thank', 'Yes', 'No',
]);
function detectNames(text) {
    const findings = [];
    const nameRegex = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b/g;
    let match;
    let counter = 0;
    while ((match = nameRegex.exec(text)) !== null) {
        if (COMMON_WORDS.has(match[1]) || COMMON_WORDS.has(match[2])) {
            continue;
        }
        counter++;
        findings.push({
            type: 'pii',
            category: 'person_name',
            match: match[0],
            start: match.index,
            end: match.index + match[0].length,
            suggestion: `PERSON_${String(counter).padStart(3, '0')}`,
            severity: 'high'
        });
    }
    return findings;
}
// ─────────────────────────────────────────────────────────────────────────────
// Main scan function — Phase 4: now also pushes to alert_store
// ─────────────────────────────────────────────────────────────────────────────
function scanPrompt(prompt, sourceLabel = '<prompt>', extensionPath) {
    const findings = [];
    let anonymized = prompt;
    let replacementCounter = 0;
    for (const pattern of PROMPT_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(prompt)) !== null) {
            replacementCounter++;
            const replacement = pattern.replaceFn(match[0], replacementCounter);
            findings.push({
                type: pattern.type,
                category: pattern.category,
                match: match[0],
                start: match.index,
                end: match.index + match[0].length,
                suggestion: replacement,
                severity: pattern.severity
            });
        }
    }
    findings.push(...detectNames(prompt));
    // Build anonymized version (replace end→start to preserve indices)
    const sortedFindings = [...findings].sort((a, b) => b.start - a.start);
    for (const f of sortedFindings) {
        anonymized = anonymized.substring(0, f.start) + f.suggestion + anonymized.substring(f.end);
    }
    // Risk level
    const hasCritical = findings.some(f => f.severity === 'critical');
    const hasHigh = findings.some(f => f.severity === 'high');
    const riskLevel = hasCritical ? 'dangerous' : hasHigh || findings.length > 0 ? 'warning' : 'safe';
    const typeCounts = findings.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
    }, {});
    const parts = [];
    if (typeCounts.pii) {
        parts.push(`${typeCounts.pii} PII`);
    }
    if (typeCounts.medical) {
        parts.push(`${typeCounts.medical} medical`);
    }
    if (typeCounts.secret) {
        parts.push(`${typeCounts.secret} secret`);
    }
    if (typeCounts.confidential) {
        parts.push(`${typeCounts.confidential} confidential`);
    }
    const summary = findings.length === 0
        ? 'Prompt appears clean — no sensitive data detected.'
        : `Found ${findings.length} sensitive item(s): ${parts.join(', ')}. Risk: ${riskLevel.toUpperCase()}.`;
    // ── Phase 4: push structured alert to alert_store ─────────────────────
    if (findings.length > 0) {
        const severity = hasCritical ? 'critical' : hasHigh ? 'high' : 'medium';
        const promptAlert = (0, alert_store_1.makeAlert)('Prompt leakage detected', severity, 'prompt_leakage', sourceLabel, summary, { policyAction: hasCritical ? 'blocked' : 'warned' });
        (0, alert_store_1.pushAlert)(promptAlert);
        // Policy evaluation
        const decision = (0, policy_engine_1.evaluatePrompt)(hasCritical, hasHigh, findings.length, extensionPath);
        // Decision message surfaced in the VS Code UI by the caller (extension.ts)
        // to avoid a circular import with vscode module.
        promptAlert._policyMessage = decision?.message;
    }
    return { isClean: findings.length === 0, findings, anonymizedPrompt: anonymized, riskLevel, summary };
}


/***/ }),
/* 17 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


/**
 * openrouter_client.ts — Hallucination-Resistant LLM Client
 *
 * Uses OpenRouter's free tier models for strictly-grounded data governance
 * analysis.  Every LLM response is validated against the real pipeline
 * measurements before being returned to the caller.
 *
 * Anti-hallucination phases implemented here:
 *   Phase 1  — Structured DATASET_CONTEXT block (ground-truth facts only)
 *   Phase 2  — Strict DATA GOVERNANCE ANALYST system prompt
 *   Phase 3  — Enforced Explanation / Evidence / Recommendation / Confidence format
 *   Phase 4  — Column-name validation + auto-regeneration
 *   Phase 5  — Metric number validation + auto-regeneration
 *   Phase 6  — Low statistical-reliability warning prefix
 *   Phase 7  — Safe fallback when analysis is not possible
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.OpenRouterClient = void 0;
const vscode = __importStar(__webpack_require__(1));
const https = __importStar(__webpack_require__(18));
const alert_store_1 = __webpack_require__(14);
const dataset_context_builder_1 = __webpack_require__(19);
// ─────────────────────────────────────────────────────────────────────────────
// Free models on OpenRouter
// ─────────────────────────────────────────────────────────────────────────────
const FREE_MODELS = [
    'meta-llama/llama-3.1-8b-instruct:free',
    'google/gemma-2-9b-it:free',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen-2-7b-instruct:free',
];
// ─────────────────────────────────────────────────────────────────────────────
// Validation constants
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum regeneration attempts before accepting the best available response */
const MAX_REGENERATION_ATTEMPTS = 2;
/** Safe fallback phrase the LLM must use when it cannot ground its answer */
const SAFE_FALLBACK = 'The requested analysis cannot be performed using the available dataset metrics.';
// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────
class OpenRouterClient {
    apiKey;
    baseUrl = 'openrouter.ai';
    currentModelIdx = 0;
    /** Set to true once a key has been injected directly via setKey() */
    _keySetDirectly = false;
    constructor(apiKey) {
        this.apiKey = apiKey || '';
        this.refreshKey();
    }
    /**
     * Directly inject an API key (e.g. from workspaceState or webview input).
     * This key takes highest priority and will not be overwritten by refreshKey().
     */
    setKey(key) {
        if (key && key !== 'PASTE_API_KEY_HERE') {
            this.apiKey = key;
            this._keySetDirectly = true;
        }
    }
    /**
     * Initialize or update the API key.
     * Priority: 1) directly set via setKey()  2) VS Code settings  3) ENV var  4) placeholder
     */
    refreshKey() {
        if (this._keySetDirectly && this.apiKey && this.apiKey !== 'PASTE_API_KEY_HERE') {
            return;
        }
        const fromSettings = vscode.workspace.getConfiguration('automate').get('openrouterApiKey', '');
        const fromEnv = (typeof process !== 'undefined' && process.env?.OPENROUTER_API_KEY) || '';
        const resolved = fromSettings || fromEnv || 'PASTE_API_KEY_HERE';
        if (resolved !== 'PASTE_API_KEY_HERE' || !this.apiKey) {
            this.apiKey = resolved;
        }
    }
    /** Check if the client is configured. */
    isConfigured() {
        this.refreshKey();
        return this.apiKey.length > 0 && this.apiKey !== 'PASTE_API_KEY_HERE';
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2 — Strict DATA GOVERNANCE ANALYST system prompt
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Build the strict governance-analyst system prompt (Phase 2).
     * The DATASET_CONTEXT block (Phase 1) is prepended so every rule
     * can reference the exact metrics available.
     */
    buildGovernanceSystemPrompt(sdc) {
        const contextBlock = (0, dataset_context_builder_1.formatStructuredDatasetContext)(sdc);
        const reliabilityScore = sdc.statistical_reliability_score;
        const parts = [
            // ── Ground-truth context (Phase 1) ──────────────────────────────
            contextBlock,
            '',
            // ── Role declaration (Phase 2) ───────────────────────────────────
            'You are a DATA GOVERNANCE ANALYST.',
            '',
            'You analyze datasets using ONLY the metrics provided in the DATASET_CONTEXT block above.',
            '',
            'STRICT RULES — violation of any rule will cause your answer to be rejected:',
            '',
            '  Rule 1: NEVER invent column names.',
            '          Only reference columns listed under "columns:" in DATASET_CONTEXT.',
            '  Rule 2: NEVER invent metrics or numeric values.',
            '          Only cite numbers that appear in DATASET_CONTEXT.',
            '  Rule 3: If a metric is missing or listed as "unavailable",',
            '          respond with the phrase "data unavailable" — do NOT estimate.',
            '  Rule 4: Always cite the exact metric name and value you used when explaining results.',
            '          Example: "privacy_score = 0.7823" or "column_drift[age] = 0.1342".',
            `  Rule 5: ${reliabilityScore != null && reliabilityScore < 0.65
                ? 'statistical_reliability_score is LOW — warn the user that results may be unreliable.'
                : 'Cite statistical_reliability_score when discussing confidence of results.'}`,
            '  Rule 6: Use ONLY the column names that appear in DATASET_CONTEXT.',
            '          If a user asks about a column not in the list, state it does not exist in the dataset.',
            '  Rule 7: If the user asks for analysis that requires data not present in DATASET_CONTEXT,',
            `          respond with exactly: "${SAFE_FALLBACK}"`,
            '',
            // ── Response format enforcement (Phase 3) ────────────────────────
            'REQUIRED RESPONSE FORMAT — every answer must use this exact structure:',
            '',
            'Explanation:',
            '  [State the result using only DATASET_CONTEXT metrics.]',
            '',
            'Evidence:',
            '  [List each metric name and exact value you referenced, e.g.:',
            '   - privacy_score = 0.7823',
            '   - dataset_risk_score = 42.50',
            '   - column_drift[salary] = 0.2341]',
            '',
            'Recommendation:',
            '  [Suggest a concrete, actionable remediation step grounded in the evidence.]',
            '',
            'Confidence:',
            `  [${reliabilityScore != null
                ? reliabilityScore > 0.8
                    ? 'High — statistical_reliability_score = ' + reliabilityScore.toFixed(4) + ' (> 0.8)'
                    : reliabilityScore >= 0.65
                        ? 'Medium — statistical_reliability_score = ' + reliabilityScore.toFixed(4) + ' (0.65–0.8)'
                        : 'Low — statistical_reliability_score = ' + reliabilityScore.toFixed(4) + ' (< 0.65)'
                : 'data unavailable'}]`,
            '',
        ];
        return parts.join('\n');
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Core HTTP chat completion
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Send a chat completion request (raw — no validation layer).
     */
    async chat(messages, model) {
        this.refreshKey();
        if (!this.apiKey) {
            return {
                content: '',
                model: '',
                error: 'OpenRouter API key not configured. Set "automate.openrouterApiKey" in VS Code settings.',
            };
        }
        const selectedModel = model || FREE_MODELS[this.currentModelIdx % FREE_MODELS.length];
        const body = JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_tokens: 2048,
            temperature: 0.3,
        });
        return new Promise((resolve) => {
            const options = {
                hostname: this.baseUrl,
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/automate-privacy',
                    'X-Title': 'AutoMate Privacy Platform',
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            this.currentModelIdx++;
                            resolve({
                                content: '',
                                model: selectedModel,
                                error: parsed.error.message || JSON.stringify(parsed.error),
                            });
                        }
                        else {
                            const choice = parsed.choices?.[0];
                            resolve({
                                content: choice?.message?.content || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage,
                            });
                        }
                    }
                    catch (e) {
                        resolve({ content: '', model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });
            req.on('error', (err) => {
                resolve({ content: '', model: selectedModel, error: `Network error: ${err.message}` });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                resolve({ content: '', model: selectedModel, error: 'Request timed out (30s)' });
            });
            req.write(body);
            req.end();
        });
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4 — Column validation
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Extract all tokens from the response that look like column references.
     * We check every word-like token against the known column list.
     */
    extractReferencedColumns(responseText, knownColumns) {
        if (knownColumns.length === 0) {
            return [];
        }
        const referenced = [];
        for (const col of knownColumns) {
            // Escape for regex and search case-insensitively
            const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(`\\b${escaped}\\b`, 'i');
            if (rx.test(responseText)) {
                referenced.push(col);
            }
        }
        return referenced;
    }
    /**
     * Return all column-like tokens in the response that are NOT in the known list.
     * Heuristic: any CamelCase or snake_case token that the model mentions in the
     * Evidence block and is not a known metric keyword.
     */
    findHallucinatedColumns(responseText, knownColumns) {
        const knownLower = new Set(knownColumns.map(c => c.toLowerCase()));
        // Extract tokens that look like identifiers (letters/digits/underscores, >= 3 chars)
        const TOKEN_RX = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g;
        const METRIC_KEYWORDS = new Set([
            // Standard section words — these are expected
            'explanation', 'evidence', 'recommendation', 'confidence', 'high', 'medium', 'low',
            'privacy', 'score', 'dataset', 'risk', 'drift', 'pii', 'reid', 'columns', 'rows',
            'statistical', 'reliability', 'metric', 'data', 'unavailable', 'analysis', 'available',
            'column', 'value', 'data', 'the', 'and', 'for', 'with', 'this', 'that', 'are',
            'can', 'not', 'have', 'has', 'will', 'should', 'may', 'each', 'all', 'any',
            'than', 'from', 'into', 'more', 'less', 'been', 'its', 'your', 'our', 'their',
            // Common English words that look like identifiers
            'rule', 'note', 'warning', 'error', 'action', 'type', 'name', 'level', 'rate',
            'true', 'false', 'null', 'none', 'based', 'above', 'below', 'result',
        ]);
        const hallucinated = [];
        let match;
        TOKEN_RX.lastIndex = 0;
        while ((match = TOKEN_RX.exec(responseText)) !== null) {
            const token = match[1].toLowerCase();
            if (!METRIC_KEYWORDS.has(token) && !knownLower.has(token) && token.length >= 3) {
                // Only flag tokens that contain underscores (strong signal of a column name)
                // or appear in an Evidence: block context
                if (match[1].includes('_')) {
                    hallucinated.push(match[1]);
                }
            }
        }
        // Deduplicate
        return [...new Set(hallucinated)];
    }
    /**
     * Validate that the LLM response only references columns from the known list.
     * Returns null if valid, or a description of the violation.
     */
    validateColumns(responseText, sdc) {
        if (sdc.columns.length === 0) {
            // No column list available — skip column validation
            return null;
        }
        const hallucinated = this.findHallucinatedColumns(responseText, sdc.columns);
        if (hallucinated.length === 0) {
            return null;
        }
        return `Response referenced column(s) not present in the dataset: ${hallucinated.join(', ')}. ` +
            `Valid columns are: ${sdc.columns.join(', ')}.`;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5 — Metric number validation
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Extract all numbers from a response text.
     */
    extractNumbers(text) {
        const NUMBER_RX = /\b\d+(?:\.\d+)?\b/g;
        const results = [];
        let m;
        while ((m = NUMBER_RX.exec(text)) !== null) {
            results.push(m[0]);
        }
        return results;
    }
    /**
     * Validate that numbers in the response were sourced from the pipeline context.
     * Returns null if valid, or a description of the violation.
     *
     * We apply a tolerance approach: small integers (0–100) used in prose
     * (e.g. "reduce risk by 30%") are allowed because they are general advice,
     * not fabricated dataset metrics.  Only decimal numbers with 2+ decimals
     * that do not match any pipeline value are flagged.
     */
    validateMetrics(responseText, sdc) {
        const validNums = (0, dataset_context_builder_1.getValidNumbers)(sdc);
        // Only validate numbers in the Evidence: block (between "Evidence:" and "Recommendation:")
        const evidenceMatch = responseText.match(/Evidence:([\s\S]*?)Recommendation:/i);
        if (!evidenceMatch) {
            return null;
        } // no Evidence block → format issue, not metric issue
        const evidenceText = evidenceMatch[1];
        const nums = this.extractNumbers(evidenceText);
        // Only flag decimal numbers (have a dot) — plain integers are too ambiguous
        const decimalOther = nums.filter(n => n.includes('.') && !validNums.has(n));
        if (decimalOther.length === 0) {
            return null;
        }
        return `Response Evidence section contains decimal value(s) not present in pipeline metrics: ` +
            `${decimalOther.join(', ')}. Only cite values from DATASET_CONTEXT.`;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6 — Low reliability warning
    // ─────────────────────────────────────────────────────────────────────────
    /** Prepend the low-reliability banner if statistical_reliability_score < 0.65 */
    applyReliabilityWarning(responseText, sdc) {
        const ris = sdc.statistical_reliability_score;
        if (ris == null || ris >= 0.65) {
            return responseText;
        }
        const warning = `⚠ Warning: Dataset metrics have low statistical reliability ` +
            `(statistical_reliability_score = ${ris.toFixed(4)}). ` +
            `Treat all scores with caution — results may not be statistically stable.\n\n`;
        return warning + responseText;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 7 — Safe fallback
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Normalise a response that the model returned as a safe fallback
     * into the required structured format.
     */
    wrapFallback(sdc) {
        const ris = sdc.statistical_reliability_score;
        const confLabel = ris != null
            ? ris > 0.8 ? 'High' : ris >= 0.65 ? 'Medium' : 'Low'
            : 'data unavailable';
        return [
            'Explanation:',
            `  ${SAFE_FALLBACK}`,
            '',
            'Evidence:',
            '  No applicable metrics were found in DATASET_CONTEXT for this query.',
            '',
            'Recommendation:',
            '  Ensure the dataset has been processed through the full pipeline so that',
            '  all required metrics are available before retrying this analysis.',
            '',
            `Confidence:\n  ${confLabel}`,
        ].join('\n');
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Validated chat — Phases 4, 5, 6, 7
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Send a governed chat request.  The response is validated against the
     * pipeline context; if invalid, regeneration is attempted up to
     * MAX_REGENERATION_ATTEMPTS times before falling back to the safe response.
     *
     * @param messages  Full message array (system prompt already included)
     * @param sdc       Structured dataset context for validation
     */
    async validatedChat(messages, sdc) {
        let lastResponse = null;
        for (let attempt = 0; attempt <= MAX_REGENERATION_ATTEMPTS; attempt++) {
            const response = await this.chat(messages);
            // Propagate hard errors immediately
            if (response.error) {
                return response;
            }
            const text = response.content;
            // Phase 7: detect if the model admitted it can't answer
            if (text.toLowerCase().includes('cannot be performed') ||
                text.toLowerCase().includes('not available in') ||
                text.toLowerCase().includes('data unavailable') && text.length < 200) {
                response.content = this.applyReliabilityWarning(this.wrapFallback(sdc), sdc);
                return response;
            }
            // Phase 4: column validation
            const colViolation = this.validateColumns(text, sdc);
            // Phase 5: metric validation
            const metricViolation = this.validateMetrics(text, sdc);
            if (!colViolation && !metricViolation) {
                // Valid response — apply Phase 6 warning and return
                response.content = this.applyReliabilityWarning(text, sdc);
                return response;
            }
            // Build a correction message to guide the next attempt
            lastResponse = response;
            const correctionParts = [
                'Your previous response was rejected because it violated the grounding rules.',
            ];
            if (colViolation) {
                correctionParts.push(`Column violation: ${colViolation}`);
            }
            if (metricViolation) {
                correctionParts.push(`Metric violation: ${metricViolation}`);
            }
            correctionParts.push('Please regenerate your answer using ONLY the column names and metric values', 'present in DATASET_CONTEXT. Do not invent any values.');
            // Append the correction as a new user turn for the next iteration
            messages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: correctionParts.join('\n') },
            ];
        }
        // All attempts exhausted — return best available response with warning
        if (lastResponse) {
            lastResponse.content = this.applyReliabilityWarning(lastResponse.content, sdc);
            return lastResponse;
        }
        // Absolute fallback
        return {
            content: this.applyReliabilityWarning(this.wrapFallback(sdc), sdc),
            model: FREE_MODELS[this.currentModelIdx % FREE_MODELS.length],
        };
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Ask a data-aware question about the pipeline.
     * Uses the strict governance-analyst prompt (Phase 2) and full validation pipeline.
     */
    async askAboutData(question, context) {
        const dsCtx = context.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(context);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ];
        return this.validatedChat(messages, sdc);
    }
    /**
     * Generate privacy recommendations based on pipeline data.
     * Uses the strict governance-analyst prompt and full validation pipeline.
     */
    async getRecommendations(context) {
        const dsCtx = context.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(context);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: 'Based on the DATASET_CONTEXT provided, generate a comprehensive list of ' +
                    'privacy and security recommendations. Prioritize by severity. ' +
                    'For each recommendation, cite the exact metric from DATASET_CONTEXT ' +
                    'that justifies it. Format as a numbered list. ' +
                    'Use only the four-section format: Explanation / Evidence / Recommendation / Confidence.',
            },
        ];
        return this.validatedChat(messages, sdc);
    }
    /**
     * Legacy method kept for backward compatibility.
     * Internally routes through the new governance-analyst prompt.
     */
    buildSystemPrompt(ctx) {
        const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
        const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
        return this.buildGovernanceSystemPrompt(sdc);
    }
    /**
     * Builds the REAL-TIME SECURITY ALERTS section for the system prompt.
     * Reads the last N alerts from alert_store and formats them for LLM analysis.
     */
    buildSecurityAlertsSection() {
        const alerts = (0, alert_store_1.getRecentAlerts)(20);
        if (alerts.length === 0) {
            return '';
        }
        const lines = [
            '',
            '## REAL-TIME SECURITY ALERTS',
            'The following alerts were detected live in the developer workspace.',
            'For each alert: explain why it is dangerous and suggest concrete mitigation steps.',
            `Total alerts in session: ${alerts.length}`,
            '',
        ];
        const groups = {};
        for (const a of alerts) {
            (groups[a.category] = groups[a.category] ?? []).push(a);
        }
        const categoryLabel = {
            secret_exposure: '🔑 Secret Exposures',
            pii_detected: '👤 PII Detections',
            prompt_leakage: '💬 Prompt Leakage',
            dataset_risk: '📊 Dataset Risk',
            policy_violation: '🚫 Policy Violations',
        };
        for (const [cat, group] of Object.entries(groups)) {
            lines.push(`### ${categoryLabel[cat] ?? cat} (${group.length})`);
            for (const a of group.slice(0, 5)) {
                lines.push(`  - [${a.severity.toUpperCase()}] ${a.type} | file: ${a.file}` +
                    (a.line ? ` line ${a.line}` : '') +
                    ` | ${a.pattern}` +
                    (a.policyAction ? ` | policy: ${a.policyAction}` : '') +
                    ` | ${a.timestamp.slice(11, 19)}`);
            }
            if (group.length > 5) {
                lines.push(`  ... and ${group.length - 5} more ${cat} alerts.`);
            }
            lines.push('');
        }
        lines.push('RULE: For every alert above, the AI MUST:', '  1. Explain the specific danger (data exposure risk, regulatory impact, attack vector).', '  2. Give concrete mitigation steps (e.g., rotate key, anonymize field, use env vars).', '  3. Cite the severity level and policy action in your response.', '');
        return lines.join('\n');
    }
}
exports.OpenRouterClient = OpenRouterClient;
// ── Concrete implementations added directly to prototype ─────────────────────
OpenRouterClient.prototype.explainDataset = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Explain this dataset using ONLY the metrics in DATASET_CONTEXT. Cover:',
                '1. OVERVIEW: total rows, column count, column names',
                '2. KEY RELATIONSHIPS: top correlated column pairs (if available)',
                '3. IMPORTANT COLUMNS: the most sensitive columns by reid_score and pii flags, with exact values',
                '4. POTENTIAL RISKS: top privacy/quality risks with exact metric evidence',
                '',
                'Use the required four-section format: Explanation / Evidence / Recommendation / Confidence.',
                'Cite exact metric values from DATASET_CONTEXT. Do NOT invent any column names or numbers.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.detectAnomalies = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const anomalies = dataset_context_builder_1.AgentTools.get_anomalies(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Analyse dataset anomalies using ONLY the metrics in DATASET_CONTEXT.',
                `Pipeline detected ${anomalies.length} anomaly signal(s):`,
                JSON.stringify(anomalies, null, 2),
                '',
                'For each anomaly:',
                '1. Name the column (must be in DATASET_CONTEXT columns list)',
                '2. Cite the exact metric value (drift score, null_ratio, etc.)',
                '3. Explain why this is problematic',
                '4. Recommend a specific remediation action',
                '',
                'Use the required four-section format: Explanation / Evidence / Recommendation / Confidence.',
                'If no anomalies were detected, explain what that means for data quality.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.suggestCleaning = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const suggestions = dsCtx.cleaning_suggestions;
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Provide data cleaning recommendations using ONLY the metrics in DATASET_CONTEXT.',
                'The pipeline identified these issues:',
                JSON.stringify(suggestions, null, 2),
                '',
                'For each issue:',
                '1. State the column and the specific problem (with measured value from DATASET_CONTEXT)',
                '2. Give a concrete, actionable fix',
                '3. Assign HIGH/MEDIUM/LOW priority with justification citing the metric',
                '',
                'Group by: Missing Values | Outliers | PII Masking | Distribution Issues',
                '',
                'Use the required four-section format: Explanation / Evidence / Recommendation / Confidence.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.generateSQL = async function (question, ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const schema = dataset_context_builder_1.AgentTools.get_sql_schema(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        'ADDITIONAL SQL RULES:',
        '  - Use ONLY column names present in the SQL Schema below and in DATASET_CONTEXT.',
        '  - Mark PII columns in SQL comments.',
        '  - Format SQL with uppercase keywords and proper indentation.',
        '  - If a requested column does not exist, state "column unavailable" and DO NOT invent one.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                `Generate a SQL query for: "${question}"`,
                '',
                `Available schema: ${JSON.stringify(schema)}`,
                '',
                'Return using the four-section format:',
                'Explanation: what the query does',
                'Evidence: which columns from DATASET_CONTEXT you used and why',
                'Recommendation: any PII/privacy warnings for columns touched',
                'Confidence: based on statistical_reliability_score',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.recommendGovernance = async function (ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const govActions = dataset_context_builder_1.AgentTools.get_pii_findings(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Propose a governance action plan using ONLY the metrics in DATASET_CONTEXT.',
                'Pipeline analysis identified:',
                JSON.stringify(govActions, null, 2),
                '',
                'Structure your Explanation section as:',
                '  ## CRITICAL ACTIONS (implement immediately)',
                '  ## HIGH PRIORITY (implement this sprint)',
                '  ## MEDIUM PRIORITY (plan within 30 days)',
                '  ## MONITORING (set up automated checks)',
                '',
                'For each action: name the column (from DATASET_CONTEXT only), the technique',
                '(masking/hashing/k-anonymity/noise/removal), and cite the exact risk score that justifies it.',
                '',
                'Then complete Evidence / Recommendation / Confidence sections as required.',
            ].join('\n'),
        },
    ];
    return this['validatedChat'](messages, sdc);
};
OpenRouterClient.prototype.agentChat = async function (history, newMessage, ctx) {
    const dsCtx = ctx.datasetCtx ?? (0, dataset_context_builder_1.buildDatasetContext)(ctx);
    const sdc = (0, dataset_context_builder_1.buildStructuredDatasetContext)(dsCtx);
    const systemPrompt = [
        this['buildGovernanceSystemPrompt'](sdc),
        '',
        'AGENT CAPABILITIES (use only when supported by DATASET_CONTEXT):',
        '  - explain dataset structure and schema',
        '  - identify risky/sensitive columns with exact scores from DATASET_CONTEXT',
        '  - detect anomalies using drift, null_ratio metrics from DATASET_CONTEXT',
        '  - suggest data cleaning strategies with specific techniques',
        '  - generate SQL queries using only actual schema column names from DATASET_CONTEXT',
        '  - recommend governance actions (masking, hashing, k-anonymity, noise)',
        '  - explain privacy risks with regulatory context (GDPR, HIPAA, PCI-DSS)',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        (0, dataset_context_builder_1.formatContextForLLM)(dsCtx),
    ].join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10), // keep last 10 turns for context window efficiency
        { role: 'user', content: newMessage },
    ];
    return this['validatedChat'](messages, sdc);
};


/***/ }),
/* 18 */
/***/ ((module) => {

module.exports = require("https");

/***/ }),
/* 19 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AgentTools = void 0;
exports.buildDatasetContext = buildDatasetContext;
exports.formatContextForLLM = formatContextForLLM;
exports.buildStructuredDatasetContext = buildStructuredDatasetContext;
exports.formatStructuredDatasetContext = formatStructuredDatasetContext;
exports.getValidNumbers = getValidNumbers;
const alert_store_1 = __webpack_require__(14);
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


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map