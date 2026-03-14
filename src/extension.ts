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
----------------------------------------
*/

function runGenerator(context: vscode.ExtensionContext, filePath: string, baselinePath: string, n: number): Promise<any> {

    return new Promise((resolve, reject) => {

        const scriptPath = path.join(context.extensionPath, "src", "utils", "generator.py");

        // 4c — use workspace-relative cache dir, not one buried inside the extension bundle
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.tmpdir();
        const cacheDir = path.join(workspaceDir, '.idelense', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });

        const proc = cp.spawn(getPythonPath(), [   // 4a
            scriptPath,
            filePath,
            baselinePath,
            "--n", String(n),
            "--cache-dir", cacheDir
        ]);

        let output = "";
        let error = "";

        proc.stdout.on("data", (data: { toString(): string }) => output += data.toString());
        proc.stderr.on("data", (data: { toString(): string }) => error += data.toString());

        proc.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(error || `generator.py exited with code ${code}`);
                return;
            }
            try {
                resolve(JSON.parse(output));
            } catch {
                reject("Invalid JSON from generator.py");
            }
        });
    });
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

function showCombinedResult(context: vscode.ExtensionContext, ast: any, baseline: any, filePath: string) {

    const panel = vscode.window.createWebviewPanel(
        "idelenseCombined",
        "IDE Lense — Parse + Baseline",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    panel.webview.html = `
    <html>
    <body style="font-family: monospace; padding: 12px;">
        <h2>IDE Lense — Parse Output</h2>
        <pre>${JSON.stringify(ast, null, 2)}</pre>

        <hr/>

        <h2>IDE Lense — Baseline Output</h2>
        <pre>${JSON.stringify(baseline, null, 2)}</pre>

        <hr/>

        <h2>Generate Synthetic Data</h2>
        <label>Rows: <input id="n" type="number" value="500" min="1" style="width:80px"/></label>
        &nbsp;
        <button onclick="generate()">Generate</button>
        <p id="status" style="color:gray;font-size:12px"></p>

        <script>
            const vscode = acquireVsCodeApi();
            function generate() {
                const n = parseInt(document.getElementById('n').value, 10);
                document.getElementById('status').textContent = 'Running...';
                vscode.postMessage({ command: 'generate', n });
            }
            window.addEventListener('message', e => {
                document.getElementById('status').textContent = e.data.text;
            });
        </script>
    </body>
    </html>
    `;

    panel.webview.onDidReceiveMessage(async (msg: any) => {
        if (msg.command !== "generate") { return; }

        const tmpPath = path.join(os.tmpdir(), `idelense_baseline_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(baseline));

        try {
            const result = await runGenerator(context, filePath, tmpPath, msg.n);
            showCheckpointMonitor(context, result);   // 4e — was showGeneratorResult(result)
            panel.webview.postMessage({ text: `✓ Done — ${result.row_count} rows (${result.generator_used})` });
        } catch (err: any) {
            panel.webview.postMessage({ text: `⚠ Error: ${err}` });
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
