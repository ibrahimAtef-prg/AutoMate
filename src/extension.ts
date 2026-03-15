import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/*
IDE Lense Extension
Detect dataset imports -> CodeLens -> parse.py -> baseline.py -> generator.py
                                                                      ↓
                                                              ValidationLayer
                                                                      ↓
                                                               CheckPoint  ← Monitor panel polls this
*/

/*
----------------------------------------
4a — Python path helper
Reads idelense.pythonPath from settings (default: "python3").
Use this everywhere instead of hardcoding "python".
----------------------------------------
*/

function getPythonPath(): string {
    const config = vscode.workspace.getConfiguration('idelense');
    return config.get<string>('pythonPath') ?? 'python3';
}

export function activate(context: vscode.ExtensionContext) {

    const provider = new DataImportCodeLensProvider();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: "file" },
            provider
        )
    );

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

                showCombinedResult(context, ast, baseline, filePath);

            } catch (err: any) {
                vscode.window.showErrorMessage("Parser Error: " + err);
            }
        })
    );

    /*
    ----------------------------------------
    4b — Register idelense.generateSynthetic
    Declared in package.json contributes.commands but was never
    registered here — caused "command not found" in the palette.
    ----------------------------------------
    */
    context.subscriptions.push(
        vscode.commands.registerCommand('idelense.generateSynthetic', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage(
                    'IDE Lense: Open a Python file that imports a dataset first.'
                );
                return;
            }
            vscode.window.showInformationMessage(
                'IDE Lense: Click the "Parse Dataset (IDE Lense)" lens above your dataset import line.'
            );
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('idelense.openCheckpoint', async () => {
            vscode.window.showInformationMessage(
                'IDE Lense: Run Parse + Generate first to open the Checkpoint Monitor.'
            );
        })
    );
}

export function deactivate() {}

/*
----------------------------------------
CodeLens Provider
----------------------------------------
*/

class DataImportCodeLensProvider implements vscode.CodeLensProvider {

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        console.log("IDE Lense scanning document");
        const ranges = detectDataImports(document);

        return ranges.map(range => {
            return new vscode.CodeLens(range, {
                title: "Parse Dataset (IDE Lense)",
                command: "idelense.parseDataset",
                arguments: [document.lineAt(range.start.line).text]
            });
        });
    }
}

/*
----------------------------------------
Detect dataset import lines
----------------------------------------
*/

function detectDataImports(document: vscode.TextDocument): vscode.Range[] {

    const regex = /(read_csv|read_excel|read_json|read_parquet|spark\.read)/g;
    const ranges: vscode.Range[] = [];

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (regex.test(line.text)) {
            ranges.push(line.range);
        }
        regex.lastIndex = 0;
    }

    return ranges;
}

/*
----------------------------------------
Extract file path from line
----------------------------------------
*/

function extractPathFromImport(line: string): string | null {
    const match = line.match(/['"]([^'"]+\.(csv|xlsx|json|parquet))['"]/);
    return match ? match[1] : null;
}

/*
----------------------------------------
Run Python Parser
----------------------------------------
*/

function runPythonParser(context: vscode.ExtensionContext, filePath: string): Promise<any> {

    return new Promise((resolve, reject) => {

        const scriptPath = path.join(context.extensionPath, "src", "utils", "parse.py");
        const proc = cp.spawn(getPythonPath(), [scriptPath, filePath]);   // 4a

        let output = "";
        let error = "";

        proc.stdout.on("data", (data: { toString(): string }) => output += data.toString());
        proc.stderr.on("data", (data: { toString(): string }) => error += data.toString());

        proc.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(error || `parse.py exited with code ${code}`);
                return;
            }
            try {
                resolve(JSON.parse(output));
            } catch {
                reject("Invalid JSON from parse.py");
            }
        });
    });
}

/*
----------------------------------------
Run Python Baseline
----------------------------------------
*/

function runBaseline(context: vscode.ExtensionContext, filePath: string, kind: string): Promise<any> {

    return new Promise((resolve, reject) => {

        const scriptPath = path.join(context.extensionPath, "src", "utils", "baseline.py");
        const proc = cp.spawn(getPythonPath(), [scriptPath, filePath, "--kind", kind]);   // 4a

        let output = "";
        let error = "";

        proc.stdout.on("data", (data: { toString(): string }) => output += data.toString());
        proc.stderr.on("data", (data: { toString(): string }) => error += data.toString());

        proc.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(error || `baseline.py exited with code ${code}`);
                return;
            }
            try {
                resolve(JSON.parse(output));
            } catch {
                reject("Invalid JSON from baseline.py");
            }
        });
    });
}

/*
----------------------------------------
Run Generator
spawnGenerator exposes the child process so the webview Cancel button
can kill it mid-run.  It also accepts an optional onProgress callback
that is fired every ~500 ms while the Python process is running by
reading the checkpoint file the generator writes to disk.

Checkpoint file location (mirrors checkp.py § default_path):
  <cacheDir>/<fingerprint[:32]>_checkpoint.json

Because we don't know the fingerprint before the first commit, we scan
the cache directory for any *_checkpoint.json that appears or is
modified after the spawn timestamp.
----------------------------------------
*/

interface GeneratorHandle {
    proc:    cp.ChildProcess;
    promise: Promise<any>;
}

interface ProgressSnapshot {
    pct        : number;   // 0–100
    collected  : number;   // rows committed so far
    requested  : number;   // target row count
    round      : number;   // number of commits so far
    status     : string;   // "in_progress" | "complete" | "failed"
    lastCommit : string;   // ISO timestamp of last commit, or ""
}

/** Scan cacheDir and return the path of the checkpoint JSON that was
 *  last-modified after `afterMs` (epoch ms).  Returns null if none found. */
function findActiveCheckpoint(cacheDir: string, afterMs: number): string | null {
    let best: string | null = null;
    let bestMtime = 0;
    try {
        for (const name of fs.readdirSync(cacheDir)) {
            if (!name.endsWith("_checkpoint.json")) { continue; }
            const full  = path.join(cacheDir, name);
            const mtime = fs.statSync(full).mtimeMs;
            if (mtime >= afterMs && mtime > bestMtime) {
                best     = full;
                bestMtime = mtime;
            }
        }
    } catch { /* cacheDir may not exist yet */ }
    return best;
}

/** Parse the checkpoint file and return a ProgressSnapshot. */
function readProgress(cpPath: string): ProgressSnapshot | null {
    try {
        const raw     = JSON.parse(fs.readFileSync(cpPath, "utf-8"));
        const commits = (raw.commits ?? []) as any[];
        const collected = commits.reduce((s: number, c: any) => s + (c.n_rows ?? 0), 0);
        const requested = Number(raw.n_requested ?? 0);
        const pct       = requested > 0 ? Math.min(100, Math.round(collected / requested * 100)) : 0;
        const lastCommit = commits.length > 0 ? (commits[commits.length - 1].committed_at ?? "") : "";
        return { pct, collected, requested, round: commits.length, status: raw.status ?? "in_progress", lastCommit };
    } catch {
        return null;
    }
}

function spawnGenerator(
    context:      vscode.ExtensionContext,
    filePath:     string,
    baselinePath: string,
    n:            number,
    cacheDir:     string,
    onProgress?:  (snap: ProgressSnapshot) => void
): GeneratorHandle {

    const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");
    const spawnTime  = Date.now();

    const proc = cp.spawn(getPythonPath(), [
        scriptPath, filePath, baselinePath,
        "--n", String(n),
        "--cache-dir", cacheDir
    ]);

    // ── Checkpoint poller ────────────────────────────────────────────────
    let cpPath: string | null = null;
    let lastRound             = -1;

    const poller = onProgress
        ? setInterval(() => {
            if (!cpPath) { cpPath = findActiveCheckpoint(cacheDir, spawnTime - 200); }
            if (!cpPath) { return; }
            const snap = readProgress(cpPath);
            if (!snap)  { return; }
            // Only fire when something actually changed
            if (snap.round !== lastRound || snap.status !== "in_progress") {
                lastRound = snap.round;
                onProgress(snap);
            }
        }, 500)
        : null;

    const promise = new Promise<any>((resolve, reject) => {
        let output = "";
        let error  = "";
        proc.stdout.on("data", (d: { toString(): string }) => output += d.toString());
        proc.stderr.on("data", (d: { toString(): string }) => error  += d.toString());
        proc.on("close", (code: number | null) => {
            if (poller) { clearInterval(poller); }
            if (code !== 0) { reject(error || `generator.py exited with code ${code}`); return; }
            try   { resolve(JSON.parse(output)); }
            catch { reject("Invalid JSON from generator.py"); }
        });
    });

    return { proc, promise };
}

/** Backward-compatible wrapper (no progress callback, no external cacheDir). */
function runGenerator(
    context:      vscode.ExtensionContext,
    filePath:     string,
    baselinePath: string,
    n:            number
): Promise<any> {
    const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
    const cacheDir     = path.join(workspaceDir, ".idelense", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    return spawnGenerator(context, filePath, baselinePath, n, cacheDir).promise;
}

/*
----------------------------------------
Infer engine name from baseline row count.
Mirrors the thresholds in generator.py:
  rows <  1 000              → statistical
  1 000 <= rows < 50 000     → probabilistic
  rows >= 50 000             → ctgan
----------------------------------------
*/

function inferEngine(rowCount: number): string {
    if (rowCount < 1_000)  { return "statistical"; }
    if (rowCount < 50_000) { return "probabilistic"; }
    return "ctgan";
}

/*
----------------------------------------
Detect kind from extension
----------------------------------------
*/

function detectKind(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".csv")     { return "csv"; }
    if (ext === ".xlsx")    { return "excel"; }
    if (ext === ".json")    { return "json"; }
    if (ext === ".parquet") { return "parquet"; }
    return "csv";
}

/*
----------------------------------------
Show parse + baseline in webview
with Generate button wired to generator
----------------------------------------
*/

/*
----------------------------------------
Show parse + baseline in webview
Generate panel at top, data panes below side-by-side.
Progress is driven by real checkpoint-file polling — the bar reflects
actual committed rows, not a fake timer.
----------------------------------------
*/

function showCombinedResult(context: vscode.ExtensionContext, ast: any, baseline: any, filePath: string) {

    const panel = vscode.window.createWebviewPanel(
        "idelenseCombined",
        "IDE Lense — Parse + Baseline",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const baselineRows: number = baseline?.meta?.row_count ?? 0;
    const engineName:   string = inferEngine(baselineRows);
    const colCount:     number = baseline?.meta?.column_count ?? 0;
    const dataKind:     string = (baseline?.meta?.dataset_kind ?? "").toUpperCase() || "—";

    const astJson      = JSON.stringify(ast,      null, 2).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const baselineJson = JSON.stringify(baseline, null, 2).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    // NOTE: No Content-Security-Policy meta tag — VS Code injects acquireVsCodeApi()
    // before user scripts, and a restrictive CSP will silently block it.
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    height     : 100%;
    font-family: var(--vscode-font-family);
    font-size  : 13px;
    color      : var(--vscode-foreground);
    background : var(--vscode-editor-background);
  }

  body {
    display       : flex;
    flex-direction: column;
    height        : 100vh;
    overflow      : hidden;
  }

  /* ── Generate panel (top strip) ─────────────────────────────── */
  .gen-panel {
    flex-shrink  : 0;
    padding      : 14px 18px 14px;
    background   : var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 2px solid var(--vscode-focusBorder, #007fd4);
  }

  .gen-title {
    font-size     : 10px;
    font-weight   : 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color         : var(--vscode-focusBorder, #007fd4);
    margin-bottom : 10px;
  }

  /* meta pills */
  .meta-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }

  .pill {
    display      : inline-flex;
    align-items  : center;
    gap          : 5px;
    padding      : 3px 9px;
    border-radius: 20px;
    font-size    : 11px;
    font-weight  : 500;
    border       : 1px solid var(--vscode-widget-border, #454545);
    background   : var(--vscode-badge-background, #3a3d41);
    color        : var(--vscode-badge-foreground, #ccc);
    white-space  : nowrap;
  }

  .pill-dot {
    width        : 6px;
    height       : 6px;
    border-radius: 50%;
    background   : var(--vscode-focusBorder, #007fd4);
    flex-shrink  : 0;
  }

  /* controls row */
  .controls-row {
    display    : flex;
    align-items: flex-end;
    gap        : 10px;
    flex-wrap  : wrap;
    margin-bottom: 14px;
  }

  .field { display:flex; flex-direction:column; gap:4px; }

  .field-label {
    font-size     : 10px;
    font-weight   : 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color         : var(--vscode-descriptionForeground);
  }

  .field-input {
    background   : var(--vscode-input-background);
    color        : var(--vscode-input-foreground);
    border       : 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555));
    border-radius: 3px;
    padding      : 5px 9px;
    font-family  : var(--vscode-font-family);
    font-size    : 13px;
    width        : 120px;
    outline      : none;
    height       : 29px;
    -moz-appearance: textfield;
  }
  .field-input::-webkit-outer-spin-button,
  .field-input::-webkit-inner-spin-button { -webkit-appearance: none; }
  .field-input:focus  { border-color: var(--vscode-focusBorder, #007fd4); }
  .field-input.invalid {
    border-color: var(--vscode-inputValidation-errorBorder, #be1100);
    background  : var(--vscode-inputValidation-errorBackground, rgba(190,17,0,.1));
  }

  .hint {
    font-size: 10px;
    margin-top: 2px;
    height : 13px;
    display: none;
  }

  /* engine chip */
  .engine-chip {
    display        : inline-flex;
    align-items    : center;
    justify-content: center;
    padding        : 0 12px;
    height         : 29px;
    border-radius  : 3px;
    font-size      : 11px;
    font-weight    : 700;
    letter-spacing : 0.08em;
    text-transform : uppercase;
    background     : color-mix(in srgb, var(--vscode-focusBorder,#007fd4) 18%, transparent);
    color          : var(--vscode-focusBorder, #007fd4);
    border         : 1px solid color-mix(in srgb, var(--vscode-focusBorder,#007fd4) 40%, transparent);
    min-width      : 110px;
  }

  /* buttons */
  .btn-primary {
    background     : var(--vscode-button-background, #0e639c);
    color          : var(--vscode-button-foreground, #fff);
    border         : none;
    border-radius  : 3px;
    padding        : 0 18px;
    font-family    : var(--vscode-font-family);
    font-size      : 12px;
    font-weight    : 600;
    cursor         : pointer;
    height         : 29px;
    display        : inline-flex;
    align-items    : center;
    gap            : 6px;
    min-width      : 100px;
    justify-content: center;
    transition     : background 0.1s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn-primary:disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }

  .btn-secondary {
    background   : var(--vscode-button-secondaryBackground, #3a3d41);
    color        : var(--vscode-button-secondaryForeground, #ccc);
    border       : none;
    border-radius: 3px;
    padding      : 0 13px;
    font-family  : var(--vscode-font-family);
    font-size    : 12px;
    cursor       : pointer;
    height       : 29px;
    display      : none;
    transition   : background 0.1s;
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

  /* dot spinner inside button */
  @keyframes dp { 0%,80%,100%{transform:scale(.55);opacity:.3} 40%{transform:scale(1);opacity:1} }
  .dots { display:none; align-items:center; gap:3px; }
  .dots span {
    display:inline-block; width:5px; height:5px; border-radius:50%;
    background:var(--vscode-button-foreground,#fff);
    animation:dp 1.3s infinite ease-in-out;
  }
  .dots span:nth-child(2){animation-delay:.15s}
  .dots span:nth-child(3){animation-delay:.30s}

  /* status badge (inline with buttons) */
  .status-badge {
    display       : none;
    align-items   : center;
    gap           : 6px;
    padding       : 0 11px;
    border-radius : 3px;
    font-size     : 11px;
    font-weight   : 600;
    border        : 1px solid transparent;
    height        : 29px;
    white-space   : nowrap;
    max-width     : 300px;
    overflow      : hidden;
    text-overflow : ellipsis;
  }
  .status-badge.running   { display:inline-flex; background:rgba(232,169,34,.12); border-color:rgba(232,169,34,.4); color:#e8a922; }
  .status-badge.done      { display:inline-flex; background:rgba(72,187,120,.12);  border-color:rgba(72,187,120,.4);  color:#48bb78; }
  .status-badge.error     { display:inline-flex; background:rgba(244,100,80,.12);  border-color:rgba(244,100,80,.4);  color:#f46450; }
  .status-badge.cancelled { display:inline-flex; background:rgba(160,160,160,.10); border-color:rgba(160,160,160,.3); color:var(--vscode-descriptionForeground); }

  /* ── Progress block ──────────────────────────────────────────── */
  .progress-block {
    display: none;   /* shown only while running or just done */
  }
  .progress-block.visible { display: block; }

  /* Track + fill */
  .prog-track {
    position     : relative;
    height       : 6px;
    border-radius: 3px;
    background   : var(--vscode-widget-border, #3a3d41);
    overflow     : hidden;
    margin-bottom: 6px;
  }

  .prog-fill {
    position      : absolute;
    inset         : 0;
    left          : 0;
    width         : 0%;
    border-radius : 3px;
    background    : var(--vscode-focusBorder, #007fd4);
    transition    : width .4s cubic-bezier(.4,0,.2,1),
                    background .3s;
  }

  /* Shimmer sweep while running */
  @keyframes shimmer {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
  .prog-fill.running::after {
    content   : '';
    position  : absolute;
    inset     : 0;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(255,255,255,.25) 50%,
      transparent 100%);
    animation : shimmer 1.6s infinite linear;
  }

  .prog-fill.complete { background: #48bb78; }
  .prog-fill.failed   { background: #f46450; }

  /* Labels row below bar */
  .prog-labels {
    display        : flex;
    justify-content: space-between;
    align-items    : center;
    font-size      : 10px;
    color          : var(--vscode-descriptionForeground);
    margin-bottom  : 8px;
  }

  .prog-pct {
    font-weight   : 700;
    font-size     : 11px;
    color         : var(--vscode-foreground);
    min-width     : 32px;
    text-align    : right;
  }

  /* Commit log */
  .commit-log {
    display   : flex;
    flex-wrap : wrap;
    gap       : 4px;
    min-height: 20px;
  }

  .commit-pill {
    display       : inline-flex;
    align-items   : center;
    gap           : 4px;
    padding       : 2px 7px;
    border-radius : 3px;
    font-size     : 10px;
    font-weight   : 500;
    background    : color-mix(in srgb, var(--vscode-focusBorder,#007fd4) 15%, transparent);
    border        : 1px solid color-mix(in srgb, var(--vscode-focusBorder,#007fd4) 35%, transparent);
    color         : var(--vscode-focusBorder, #007fd4);
    animation     : pill-in .2s ease;
  }

  @keyframes pill-in {
    from { opacity:0; transform:scale(.85); }
    to   { opacity:1; transform:scale(1);   }
  }

  /* ── Bottom data panes ───────────────────────────────────────── */
  .data-area {
    flex                 : 1;
    display              : grid;
    grid-template-columns: 1fr 1fr;
    min-height           : 0;
    overflow             : hidden;
  }

  .data-pane {
    display       : flex;
    flex-direction: column;
    min-height    : 0;
    overflow      : hidden;
  }

  .data-pane + .data-pane {
    border-left: 1px solid var(--vscode-widget-border, #454545);
  }

  .pane-header {
    flex-shrink    : 0;
    padding        : 7px 14px;
    display        : flex;
    align-items    : center;
    justify-content: space-between;
    background     : var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom  : 1px solid var(--vscode-widget-border, #454545);
  }

  .pane-title {
    font-size     : 10px;
    font-weight   : 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color         : var(--vscode-descriptionForeground);
  }

  .pane-badge {
    font-size    : 10px;
    font-weight  : 600;
    padding      : 1px 7px;
    border-radius: 20px;
    background   : var(--vscode-badge-background, #3a3d41);
    color        : var(--vscode-badge-foreground, #ccc);
    border       : 1px solid var(--vscode-widget-border, #454545);
  }

  pre {
    flex       : 1;
    margin     : 0;
    padding    : 12px 14px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size  : 11.5px;
    line-height: 1.55;
    overflow   : auto;
    white-space: pre;
    word-break : normal;
    background : transparent;
    color      : var(--vscode-editor-foreground, var(--vscode-foreground));
  }
</style>
</head>
<body>

<!-- ── GENERATE PANEL ────────────────────────────────────────── -->
<div class="gen-panel">

  <div class="gen-title">Generate Synthetic Data</div>

  <div class="meta-row">
    <span class="pill"><span class="pill-dot"></span>${dataKind}</span>
    <span class="pill"><span class="pill-dot"></span>${baselineRows.toLocaleString()} baseline rows</span>
    <span class="pill"><span class="pill-dot"></span>${colCount} columns</span>
  </div>

  <!-- Input + buttons -->
  <div class="controls-row">
    <div class="field">
      <span class="field-label">Rows to generate</span>
      <input id="rowInput" class="field-input" type="number"
             value="500" min="1" max="100000" autocomplete="off"/>
      <div id="hint" class="hint"></div>
    </div>

    <div class="field">
      <span class="field-label">Engine</span>
      <span id="engineChip" class="engine-chip">${engineName}</span>
    </div>

    <button id="btnGenerate" class="btn-primary">
      <span class="dots" id="dots"><span></span><span></span><span></span></span>
      <span id="btnLabel">Generate</span>
    </button>

    <button id="btnCancel" class="btn-secondary">Cancel</button>

    <div id="statusBadge" class="status-badge"></div>
  </div>

  <!-- Progress block (hidden until run starts) -->
  <div id="progressBlock" class="progress-block">
    <div class="prog-track">
      <div id="progFill" class="prog-fill"></div>
    </div>
    <div class="prog-labels">
      <span id="progDetail">Waiting for first commit…</span>
      <span id="progPct" class="prog-pct">0%</span>
    </div>
    <div id="commitLog" class="commit-log"></div>
  </div>

</div>

<!-- ── DATA PANES ────────────────────────────────────────────── -->
<div class="data-area">
  <div class="data-pane">
    <div class="pane-header">
      <span class="pane-title">Parse Output</span>
      <span class="pane-badge">AST</span>
    </div>
    <pre>${astJson}</pre>
  </div>
  <div class="data-pane">
    <div class="pane-header">
      <span class="pane-title">Baseline Output</span>
      <span class="pane-badge">Stats</span>
    </div>
    <pre>${baselineJson}</pre>
  </div>
</div>

<script>
(function () {
  'use strict';

  // acquireVsCodeApi is injected by the VS Code runtime before this script
  // runs. Never add a Content-Security-Policy that blocks it.
  const vscode = acquireVsCodeApi();

  const MAX_ROWS  = 100_000;
  const WARN_ROWS = 50_000;

  const rowInput   = document.getElementById('rowInput');
  const hint       = document.getElementById('hint');
  const btnGen     = document.getElementById('btnGenerate');
  const btnCancel  = document.getElementById('btnCancel');
  const dots       = document.getElementById('dots');
  const btnLabel   = document.getElementById('btnLabel');
  const badge      = document.getElementById('statusBadge');
  const chipEl     = document.getElementById('engineChip');
  const progBlock  = document.getElementById('progressBlock');
  const progFill   = document.getElementById('progFill');
  const progPct    = document.getElementById('progPct');
  const progDetail = document.getElementById('progDetail');
  const commitLog  = document.getElementById('commitLog');

  const BASELINE_ROWS = ${baselineRows};
  let isRunning = false;

  function engineName(r) {
    if (r < 1000)  return 'statistical';
    if (r < 50000) return 'probabilistic';
    return 'ctgan';
  }

  /* ── validation ─────────────────────────────────────────────── */
  function validate() {
    const raw = rowInput.value.trim();
    const n   = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return { ok: false, n: NaN, msg: 'Enter a whole number greater than 0', warn: false };
    }
    if (n > MAX_ROWS) {
      return { ok: false, n, msg: 'Maximum is 100,000 rows', warn: false };
    }
    return { ok: true, n, msg: n > WARN_ROWS ? '⚠ Large count — may take several minutes' : '', warn: true };
  }

  function refreshUI() {
    const { ok, msg, warn } = validate();
    rowInput.classList.toggle('invalid', !ok);
    hint.style.display  = msg ? 'block' : 'none';
    hint.style.color    = warn ? '#e8a922' : 'var(--vscode-inputValidation-errorForeground, #f48771)';
    hint.textContent    = msg;
    btnGen.disabled     = !ok || isRunning;
    chipEl.textContent  = engineName(BASELINE_ROWS);
  }

  /* ── state helpers ───────────────────────────────────────────── */
  function setRunning(on) {
    isRunning               = on;
    btnGen.disabled         = on;
    dots.style.display      = on ? 'flex'         : 'none';
    btnLabel.textContent    = on ? 'Generating…'  : 'Generate';
    btnCancel.style.display = on ? 'inline-block' : 'none';
    rowInput.disabled       = on;
  }

  function showBadge(cls, text) {
    badge.className   = 'status-badge ' + cls;
    badge.textContent = text;
  }

  /* ── progress helpers ────────────────────────────────────────── */
  let knownRounds = 0;

  function resetProgress() {
    knownRounds        = 0;
    progFill.style.width  = '0%';
    progFill.className    = 'prog-fill running';
    progPct.textContent   = '0%';
    progDetail.textContent = 'Waiting for first commit…';
    commitLog.innerHTML   = '';
    progBlock.classList.add('visible');
  }

  function applyProgress(data) {
    const pct = Math.min(data.pct, 100);

    progFill.style.width  = pct + '%';
    progPct.textContent   = pct + '%';
    progDetail.textContent =
      data.collected.toLocaleString() + ' / ' + data.requested.toLocaleString() +
      ' rows  ·  round ' + data.round;

    // Append a pill for each new round that arrived since last update
    for (let r = knownRounds + 1; r <= data.round; r++) {
      const pill = document.createElement('span');
      pill.className   = 'commit-pill';
      pill.textContent = 'Round ' + r;
      commitLog.appendChild(pill);
    }
    knownRounds = data.round;
  }

  function finalizeProgress(success) {
    progFill.className = 'prog-fill ' + (success ? 'complete' : 'failed');
    progFill.style.width = success ? '100%' : progFill.style.width;
    if (success) {
      progPct.textContent    = '100%';
      progDetail.textContent = 'Complete';
    }
  }

  /* ── actions ─────────────────────────────────────────────────── */
  btnGen.addEventListener('click', function () {
    const { ok, n } = validate();
    if (!ok || isRunning) return;
    setRunning(true);
    showBadge('running', '⏳  Running…');
    resetProgress();
    vscode.postMessage({ command: 'generate', n: n });
  });

  btnCancel.addEventListener('click', function () {
    vscode.postMessage({ command: 'cancel' });
    setRunning(false);
    finalizeProgress(false);
    showBadge('cancelled', '⬛  Cancelled');
  });

  /* ── messages from extension host ───────────────────────────── */
  window.addEventListener('message', function (event) {
    var d = event.data;

    if (d.type === 'progress') {
      applyProgress(d);
      return;
    }

    setRunning(false);

    if (d.type === 'done') {
      finalizeProgress(true);
      showBadge('done', '✅  Done — ' + d.text);
    } else if (d.type === 'error') {
      finalizeProgress(false);
      showBadge('error', '❌  ' + d.text);
    }
  });

  rowInput.addEventListener('input', refreshUI);
  refreshUI();
}());
</script>
</body>
</html>`;

    // ── Active generator process handle (for Cancel support) ─────────────
    let activeHandle: GeneratorHandle | null = null;

    panel.webview.onDidReceiveMessage(async (message: any) => {

        if (message.command === "cancel") {
            if (activeHandle) {
                try { activeHandle.proc.kill(); } catch {}
                activeHandle = null;
            }
            return;
        }

        if (message.command !== "generate") { return; }

        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir     = path.join(workspaceDir, ".idelense", "cache");
        fs.mkdirSync(cacheDir, { recursive: true });

        const tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(baseline));

        // Wire the progress callback → webview postMessage
        activeHandle = spawnGenerator(
            context, filePath, tmpPath, message.n, cacheDir,
            (snap) => {
                panel.webview.postMessage({
                    type      : "progress",
                    pct       : snap.pct,
                    collected : snap.collected,
                    requested : snap.requested,
                    round     : snap.round,
                });
            }
        );

        try {
            const result  = await activeHandle.promise;
            activeHandle  = null;
            showCheckpointMonitor(context, result);
            panel.webview.postMessage({
                type: "done",
                text: `${result.row_count} rows (${result.generator_used})`
            });
        } catch (err: any) {
            activeHandle = null;
            const errStr = String(err);
            if (errStr.includes("code null") || errStr.includes("killed")) { return; }
            panel.webview.postMessage({ type: "error", text: errStr });
            vscode.window.showErrorMessage("Generator error: " + err);
        } finally {
            try { fs.unlinkSync(tmpPath); } catch {}
        }

    }, undefined, context.subscriptions);
}

/*
----------------------------------------
4f — CheckPoint Monitor (replaces showGeneratorResult)
Background agent panel — reads the checkpoint JSON file directly,
no Python process needed. Polls every 2 s while status=in_progress,
stops automatically once the run is sealed complete or failed.
----------------------------------------
*/

function showCheckpointMonitor(context: vscode.ExtensionContext, result: any) {

    const panel = vscode.window.createWebviewPanel(
        'idelenseCheckpoint',
        'IDE Lense — Generation Monitor',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const cpPath: string = result.checkpoint_path ?? '';

    function readCheckpoint(): any {
        try {
            return JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    function buildHtml(cp: any): string {
        const status     = cp?.status ?? 'unknown';
        const nReq       = cp?.n_requested ?? 0;
        const commits    = cp?.commits ?? [];
        const nCollected = commits.reduce((s: number, c: any) => s + (c.n_rows ?? 0), 0);
        const pct        = nReq > 0 ? Math.round(nCollected / nReq * 100) : 0;
        const genUsed    = cp?.generator_used ?? result.generator_used ?? '—';
        const warnings   = (cp?.final_warnings ?? result.warnings ?? []) as string[];
        const rows       = cp?.rows ?? result.samples ?? [];

        const statusColor = status === 'complete' ? '#4caf50'
                          : status === 'failed'   ? '#f44336'
                          :                         '#ff9800';

        const commitRows = commits.map((c: any) => `
            <tr>
                <td>${c.commit_id}</td>
                <td>${c.round}</td>
                <td>${c.n_rows}</td>
                <td>${c.cumulative}</td>
                <td>${c.validation?.n_rejected_quality ?? 0}</td>
                <td>${c.validation?.n_rejected_duplicates ?? 0}</td>
                <td>${c.validation?.n_repaired_constraints ?? 0}</td>
                <td style="font-size:10px;color:gray">${c.committed_at ?? ''}</td>
            </tr>`).join('');

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); padding: 16px;
         color: var(--vscode-foreground);
         background: var(--vscode-editor-background); }
  h2   { margin-bottom: 4px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:12px;
           color:#fff; font-size:12px; font-weight:bold;
           background:${statusColor}; }
  .progress-bar-bg { background: var(--vscode-editorWidget-border);
                     border-radius: 4px; height: 10px; margin: 8px 0; }
  .progress-bar-fg { background: ${statusColor}; height: 10px;
                     border-radius: 4px; width: ${pct}%;
                     transition: width .4s ease; }
  table  { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 12px; }
  th, td { border: 1px solid var(--vscode-editorWidget-border);
           padding: 4px 8px; text-align: right; }
  th     { background: var(--vscode-editorGroupHeader-tabsBackground);
           text-align: center; }
  .warn  { color: #ff9800; font-size: 11px; }
  pre    { font-size: 11px; max-height: 400px; overflow: auto;
           background: var(--vscode-textCodeBlock-background);
           padding: 8px; border-radius: 4px; }
</style>
</head>
<body>
  <h2>Generation Monitor</h2>
  <p>
    Engine: <b>${genUsed}</b> &nbsp;|&nbsp;
    Status: <span class="badge">${status}</span> &nbsp;|&nbsp;
    Rows: <b>${nCollected} / ${nReq}</b>
  </p>
  <div class="progress-bar-bg"><div class="progress-bar-fg"></div></div>
  <p style="font-size:11px;color:gray;margin-top:0">${pct}% complete</p>

  <h3>Per-Round Commits</h3>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Round</th><th>Rows Added</th><th>Total</th>
        <th>Rejected (Quality)</th><th>Rejected (Dedup)</th>
        <th>Repaired</th><th>Time</th>
      </tr>
    </thead>
    <tbody>${commitRows || '<tr><td colspan="8" style="text-align:center">No commits yet</td></tr>'}</tbody>
  </table>

  ${warnings.length ? `
  <h3>Warnings</h3>
  <ul class="warn">${warnings.map((w: string) => `<li>${w}</li>`).join('')}</ul>` : ''}

  <h3>Samples (first 20 rows)</h3>
  <pre>${JSON.stringify(rows.slice(0, 20), null, 2)}</pre>
  <p style="font-size:10px;color:gray">Checkpoint: ${cpPath}</p>
</body>
</html>`;
    }

    // Initial render with whatever is on disk right now
    panel.webview.html = buildHtml(readCheckpoint() ?? {});

    // Poll every 2 s while the run is still in_progress
    const timer = setInterval(() => {
        const cp = readCheckpoint();
        if (!cp) { return; }
        panel.webview.html = buildHtml(cp);
        if (cp.status !== 'in_progress') { clearInterval(timer); }
    }, 2000);

    // Stop polling if the user closes the panel
    panel.onDidDispose(() => clearInterval(timer), null, context.subscriptions);
}
