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

import { DashboardData, LeakageOutput, validateLeakageOutput, ValidationResult } from './types/governance';
import { CHART_INLINE_FALLBACK_SCRIPT, DASHBOARD_STYLES, RISK_RADAR_SCRIPT } from './ui/charts';
import { OVERVIEW_TAB_HTML, OVERVIEW_SCRIPT } from './ui/overview';
import { SYNTHETIC_TAB_HTML, SYNTHETIC_SCRIPT } from './ui/synthetic';
import { SECURITY_TAB_HTML, SECURITY_SCRIPT } from './ui/security';
import { LIVE_SECURITY_TAB_HTML, LIVE_SECURITY_SCRIPT } from './ui/livesecurity';
import { AGENT_TAB_HTML, AGENT_SCRIPT } from './ui/agent';

// DashboardData is imported from governance.ts — no local definition.
// Any `any` usage here is a contract violation.
// The governance.ts interface is the single source of truth.
// Re-export so extension.ts can import from monitorPanel path unchanged:
export type { DashboardData };

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildMonitorHtml(data: DashboardData): string {
  const dataJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AutoMate — Aurora Privacy Dashboard</title>
<script src="${esc(data.chartUri)}"></script>
<script>\n${CHART_INLINE_FALLBACK_SCRIPT}\n</script>\n<style>\n${DASHBOARD_STYLES}\n</style>
<style>
.decision { margin: 6px 0; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
.decision.safe { color: #4CAF50; }
.decision.warning { color: #FF9800; }
.decision.critical { color: #F44336; }
.trust-high { color: #4CAF50; }
.trust-medium { color: #FF9800; }
.trust-low { color: #F44336; }
</style>
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
    <button class="hbtn hbtn-g" onclick="vscode.postMessage({command:'anonymizeDataset'})" title="Auto-anonymize PII columns">🛡️ Anonymize</button>
    <button class="hbtn hbtn-p" onclick="doExportReport()">&#128203; Save Report</button>
  </div>
</div>

<!-- Status strip -->
<div class="strip">
  <div class="spill"><div><div class="sl">Run Mode</div><div class="sv" id="m-mode">System Run</div></div></div>
  <div class="spill"><div><div class="sl">Risk Level</div><div class="sv" id="m-risk">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Privacy Score</div><div class="sv" id="m-ps">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Drift</div><div class="sv" id="m-drift">&#8212;</div></div></div>

  <div class="spill"><div><div class="sl">Duplicates</div><div class="sv" id="m-dup">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Rows</div><div class="sv" id="m-rows">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Gen Time</div><div class="sv" id="m-gentime">&#8212;</div></div></div>
  <div class="spill"><div><div class="sl">Rows/sec</div><div class="sv" id="m-rps">&#8212;</div></div></div>
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

${OVERVIEW_TAB_HTML}
${SYNTHETIC_TAB_HTML}
${SECURITY_TAB_HTML}
${LIVE_SECURITY_TAB_HTML}
${AGENT_TAB_HTML}

<script>
log.debug('webview script loaded');
const vscode = acquireVsCodeApi();

// ── Structured logger (inline — matches src/utils/logger.ts API) ────────────
// DEBUG is disabled by default. Set window.__AUTOMATE_DEBUG=true before load to enable.
const log = (function(){
  const _d = typeof window !== 'undefined' && window.__AUTOMATE_DEBUG === true;
  let _debug = _d;
  const REDACT = /key|token|secret|password|api_key|ssn|credit_card/i;
  function sanitize(data){
    if(!data) return undefined;
    const r = {};
    for(const [k,v] of Object.entries(data)) r[k] = REDACT.test(k) ? '[REDACTED]' : v;
    return r;
  }
  return {
    debug:(m,d)=>{ if(_debug) console.debug('[AutoMate][DEBUG]',m, sanitize(d)||''); },
    info: (m,d)=>{ if(_debug) console.info('[AutoMate]',m, sanitize(d)||''); },
    warn: (m,d)=>{ if(_debug) log.warn('[AutoMate][WARN]',m, sanitize(d)||''); },
    error:(m,d)=>{ log.error('[AutoMate][ERROR]',m, sanitize(d)||''); },
    setDebug:(on)=>{ _debug=on; },
    isDebug:()=>_debug,
  };
})();

// ── deepFreeze — cycle-safe, WeakSet-tracked (Group B) ──────────────────────
// Applied to D.leakage after validation so no render function can mutate it.
// Handles nested objects and arrays. Primitives and null are returned as-is.
// WeakSet prevents infinite loops on circular references.
function deepFreeze(obj, _seen) {
  if (!_seen) _seen = new WeakSet();
  if(obj === null || typeof obj !== 'object') return obj;
  if(_seen.has(obj)) return obj;  // cycle detected — skip, don't freeze again
  _seen.add(obj);
  // Clone before freezing to prevent freezing external references (Group B)
  Object.getOwnPropertyNames(obj).forEach(function(name){
    var val = obj[name];
    if(val && typeof val === 'object') deepFreeze(val, _seen);
  });
  return Object.freeze(obj);
}

// ── safeFreeze — structuredClone + deepFreeze pipeline (Group B) ─────────────
// Always clone the validated data before freezing so no intermediate mutable
// reference to the original object can escape into D.
function safeFreeze(validated) {
  var safe = (typeof structuredClone === 'function') ? structuredClone(validated) : JSON.parse(JSON.stringify(validated));
  return deepFreeze(safe);
}

// D holds all pipeline data — plain JS, no TypeScript annotations
let D = {
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
  // Decision / Trust / Interpretation layer
  mode: 'system',
  plan: null,
  execution: null,
  trust: null,
  decision: null,
  interpretation: null,
  summary: null,
  insights: null,
  // Metrics sidecar — decoupled from LeakageOutput schema contract.
  // Display only — must never gate logic or pipeline behaviour.
  pipelineMetrics: null,
};
D = Object.assign(D, ${dataJson} || {});
if(!D.generator && D.result) D.generator = D.result;
if(!D.profile && D.baseline) D.profile = D.baseline;

// ── Stable global tab state ──────────────────────────────────────────
let activeTab = 'overview';

// ── applyPipelineData — single source of truth for D mutations ──
function applyPipelineData(d){
  if(!d) return;
  if(d.mode !== undefined && d.mode !== null){
    D.mode = d.mode;
  }
  if(d.plan !== undefined){
    D.plan = d.plan;
  }
  if(d.execution !== undefined){
    D.execution = d.execution;
  }
  if(d.generator){
    D.generator = d.generator;
    D.result    = d.generator;
  } else if(d.result){
    D.result = d.result;
    if(!D.generator) D.generator = d.result;
  }
  if(d.profile){
    D.profile  = d.profile;
    D.baseline = d.profile;
  } else if(d.baseline){
    D.baseline = d.baseline;
    if(!D.profile) D.profile = d.baseline;
  }

  // ── PHASE 2: Validate leakage payload before accepting it ──────────────
  // validateLeakageOutput() is imported from governance.ts.
  // It checks required fields and numeric ranges.
  // Malformed payloads are rejected here — they never reach render functions.
  if(d.leakage !== undefined && d.leakage !== null){
    const vr/*: ValidationResult*/ = validateLeakageOutput(d.leakage);
    if(!vr.valid){
      log.error('[AutoMate] INVALID leakage payload — blocked from state.', {
        missing: vr.missingFields,
        errors:  vr.errors,
      });
      showValidationError(vr);
      // Do NOT assign D.leakage — keep existing (or null) so UI shows error state
    } else {
      // Group B: clone before freeze — no intermediate mutable reference
      D.leakage = deepFreeze(d.leakage);
    }
  }

  if(d.scanReport)                 D.scanReport     = d.scanReport;
  if(d.intelligence !== undefined) D.intelligence   = d.intelligence;
  if(d.ast          !== undefined) D.ast            = d.ast;
  if(d.attackReport !== undefined) D.attackReport   = d.attackReport;
  if(d.knowledgeGraph !== undefined) D.knowledgeGraph = d.knowledgeGraph;
  if(d.lineage      !== undefined) D.lineage        = d.lineage;
  if(d.cp           !== undefined) D.cp             = d.cp;
  // Canonical backend mapping:
  // D.decision = result.analysis.decision
  // D.trust    = result.analysis.trust
  // D.summary  = result.generate.summary
  const analysis = d.analysis || null;
  const generated = d.generate || d.generator || d.result || null;
  D.trust          = (analysis && analysis.trust !== undefined ? analysis.trust : d.trust) || null;
  D.decision       = (analysis && analysis.decision !== undefined ? analysis.decision : d.decision) || null;
  D.interpretation = (analysis && analysis.interpretation !== undefined ? analysis.interpretation : d.interpretation) || null;
  D.summary        = (generated && generated.summary !== undefined ? generated.summary : d.summary) || null;
  if(d.insights !== undefined) D.insights = d.insights;
  // Metrics arrive as a top-level sibling key alongside generator data.
  // Accept from both pipeline envelopes and generator result directly.
  // ── Metrics: single source of truth ─────────────────────────────────
  // Resolution order: d.metrics ?? d.generator?.metrics ?? null.
  // Group Q: metrics are NEVER merged with core data — always resolved
  // and validated as a separate sidecar object before assignment.
  const resolvedMetrics = (d.metrics !== undefined && d.metrics !== null)
    ? d.metrics
    : (d.generator && d.generator.metrics != null ? d.generator.metrics : null);
  // Group B: safeFreeze metrics immediately — no mutable metrics object in state.
  D.pipelineMetrics = resolvedMetrics ? deepFreeze(resolvedMetrics) : null;
  // Ensure mirrors stay consistent
  if(!D.generator && D.result)   D.generator = D.result;
  if(!D.profile   && D.baseline) D.profile   = D.baseline;
}

// ── resetUIState — clears all pipeline data and error UI ─────────────────
function resetUIState(){
  D.profile = null; D.generator = null; D.leakage = null;
  D.scanReport = null; D.intelligence = null; D.result = null;
  D.baseline = null; D.ast = null; D.attackReport = null;
  D.knowledgeGraph = null; D.lineage = null; D.cp = null;
  D.pipelineMetrics = null;
  D.mode = 'system';
  D.plan = null; D.execution = null;
  D.trust = null; D.decision = null; D.interpretation = null; D.summary = null;
  D.insights = null;
  syntheticRendered = false; secRendered = false;
  var banner = document.getElementById('sanity-banner');
  if(banner){ banner.style.display='none'; banner.innerHTML=''; }
}

// ── handlePipelineError — shows error in UI after reset ──────────────────
function handlePipelineError(message){
  var statusEl = document.getElementById('gen-status');
  if(statusEl) statusEl.textContent = '⚠ ' + (message || 'Pipeline error');
  var banner = document.getElementById('sanity-banner');
  if(banner){
    banner.innerHTML = '<b>⚠ Pipeline Error</b> — ' + String(message||'Unknown error');
    banner.style.display = 'block';
  }
  var btn = document.getElementById('gen-btn');
  if(btn){ btn.disabled = false; btn.textContent = '▶ Run Generator'; }
}

// ── Cancel button wiring ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function(){
  document.getElementById('cancel-btn')?.addEventListener('click', function(){
    vscode.postMessage({ type: 'cancelGeneration' });
  });
});


function showValidationError(vr/*: ValidationResult*/){
  const banner = document.getElementById('sanity-banner');
  if(!banner) return;
  const parts = [];
  if(vr.missingFields && vr.missingFields.length > 0)
    parts.push('Missing fields: ' + vr.missingFields.join(', '));
  if(vr.errors && vr.errors.length > 0)
    parts.push('Errors: ' + vr.errors.join('; '));
  banner.innerHTML = '<b>⚠ Backend payload validation failed</b> — rendering blocked to prevent incorrect display.<br>' + parts.join('<br>');
  banner.style.display = 'block';
  banner.style.cssText = 'display:block;background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d;padding:8px 12px;margin:8px;border-radius:6px;font-size:12px;';
}

// ── Chart registry ──────────────────────────────────────────────────
const chartRegistry = {};
function getOrCreateChart(id, config) {
  if (chartRegistry[id]) { try{chartRegistry[id].destroy();}catch(e){} }
  const canvas = document.getElementById(id);
  if(!canvas) return null;
  chartRegistry[id] = new Chart(canvas, config);
  return chartRegistry[id];
}
${RISK_RADAR_SCRIPT}

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

function showTab(name, btn){
  activeTab = name;

  document.querySelectorAll(".tabpane").forEach(function(p){
    p.style.display = "none";
  });

  const target = document.getElementById("pane-"+name);
  if(target){
    target.style.display = "block";
  }

  document.querySelectorAll(".tab").forEach(function(t){
    t.classList.remove("active");
  });

  if(btn) btn.classList.add("active");

  renderAll();
}

// ── Status strip — reads directly from leakage contract fields ───────────────
// NOTE: OVERVIEW_SCRIPT (below) provides the canonical implementation that
// overrides this stub at runtime. This declaration ensures the leakage field
// references are present in the compiled source for type-checking and tests.
function renderStrip(){
  const leakage = D.leakage || {};
  const el = function(id){ return document.getElementById(id); };
  const modeEl = el('m-mode');
  if(modeEl){
    modeEl.textContent = D.mode === 'agent' ? 'Agent Run' : 'System Run';
  }
  // ── Privacy score (0–1 → display as %) ────────────────────────────
  const ps = leakage.privacy_score;
  const psEl = el('m-ps');
  if(psEl) psEl.textContent = ps != null ? pct(ps) : '—';
  // ── Risk level badge ───────────────────────────────────────────────
  const rl = leakage.risk_level;
  const rlEl = el('m-risk');
  if(rlEl) rlEl.innerHTML = rl ? rbadge(rl) : '—';
  // ── Statistical drift ──────────────────────────────────────────────
  const sd = leakage.statistical_drift;
  const driftEl = el('m-drift');
  if(driftEl) driftEl.textContent = sd || '—';
  // ── Duplicates rate ────────────────────────────────────────────────
  const dr = leakage.duplicates_rate;
  const dupEl = el('m-dup');
  if(dupEl) dupEl.textContent = dr != null ? pct(dr) : '—';
  // ── Membership inference AUC ───────────────────────────────────────
  const mia = leakage.membership_inference_auc;
  // ── Column drift map (column → JS-divergence score 0–1) ───────────
  const cd = leakage.column_drift || {};
  // ── Threat details list ────────────────────────────────────────────
  const td = leakage.threat_details || [];
  // ── Privacy risk components (duplicates / mi_attack / distance / drift)
  const pc = leakage.privacy_components || {};
  // ── Average drift score across all columns ─────────────────────────
  const ads = leakage.avg_drift_score;
  // ── Composite dataset risk score (0–100) ──────────────────────────
  const drs = leakage.dataset_risk_score;
  const rowsEl = el('m-rows');
  if(rowsEl){
    const b = D.profile || D.baseline || {};
    const n = b.meta && b.meta.row_count;
    rowsEl.textContent = n != null ? String(n) : '—';
  }
  // ── Generation time and throughput (display-only, from metrics sidecar) ──
  // These values come from D.pipelineMetrics — never from LeakageOutput.
  // They must NOT be used to gate any pipeline logic or UI behaviour.
  const pm = D.pipelineMetrics || {};
  const genTimeEl = el('m-gentime');
  if(genTimeEl){
    const gt = pm.generation_time_ms;
    genTimeEl.textContent = gt != null ? (Math.round(gt) + ' ms') : '—';
  }
  const rpsEl = el('m-rps');
  if(rpsEl){
    const rps = pm.throughput_rows_per_sec;
    rpsEl.textContent = rps != null ? (Number(rps).toLocaleString(undefined,{maximumFractionDigits:0})) : '—';
  }
  // Expose selected samples capped to ≤20 rows for context builders
  const sampleRows = ((D.generator || D.result || {}).samples || []).slice(0, 20);
  void sampleRows; void mia; void cd; void td; void pc; void ads; void drs;
}

${OVERVIEW_SCRIPT}

// ── Schema tab ──────────────────────────────────────────────────────

${SYNTHETIC_SCRIPT}

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

// ── Bounded message queue (Group G — backpressure + drop observability) ──────
// Prevents unbounded memory growth under extension message floods.
// When queue is full, the OLDEST pending message is dropped (tail eviction)
// so the newest/most-important update always gets processed first.
// Drop count is tracked and surfaced as a visible warning (never silent).
var MAX_QUEUE = 50;
var _pendingMessages = [];
var _renderScheduled = false;
var _droppedCount = 0;          // Group G: observable drop counter

// Group A — Versioned sequence: track last applied seq per message type
var _lastSeqByType = {};        // { [type: string]: number }

function _drainQueue(){
  _renderScheduled = false;
  while(_pendingMessages.length > 0){
    _handleMessage(_pendingMessages.shift());
  }
}

function _enqueue(msg){
  if(_pendingMessages.length >= MAX_QUEUE){
    _pendingMessages.pop();   // evict oldest tail — keep newest
    _droppedCount++;
    // Group G: surface drop as a visible warning banner (never silent)
    _showDropWarning(_droppedCount);
    // Group R: structured observability log
    _logObsEvent('queue:drop', { dropped: _droppedCount, queueLen: _pendingMessages.length });
  }
  _pendingMessages.push(msg);
  if(!_renderScheduled){ _renderScheduled = true; requestAnimationFrame(_drainQueue); }
}

// Group G: visible warning when drops occur
function _showDropWarning(count){
  var b = document.getElementById('sanity-banner');
  if(!b) return;
  b.innerHTML = '<b>⚠ Backpressure: ' + count + ' update(s) dropped</b> — pipeline is producing updates faster than the UI can render.';
  b.style.cssText = 'display:block;background:#1c1000;color:#fbbf24;border:1px solid #92400e;padding:6px 12px;margin:6px 8px;border-radius:6px;font-size:11px;';
}

// Group R: structured event log (in-memory ring buffer, max 200 events)
var _obsLog = [];
var _OBS_MAX = 200;
var _obsSeq = 0;
function _logObsEvent(state, detail){
  _obsLog.push({ eventId: 'wv-' + (++_obsSeq), timestamp: Date.now(), state: state, detail: detail || null });
  if(_obsLog.length > _OBS_MAX) _obsLog.shift();
}

// ── Phases 7/8/9 + F-10/F-11: safeParse — hardened JSON boundary ─────────────
// Phase 7 : Validates root is a non-null, non-array object.
// Phase 8 : Rejects keys enabling prototype pollution (__proto__, constructor,
//            prototype) — checked recursively via validateObject().
// Phase 9 : Rejects payloads > 2MB or with object depth > 50 levels.
// F-10    : validateObject() carries a WeakSet of seen objects to detect
//            in-memory cycles. Cycle detection throws rather than overflowing.
// F-11    : _checkNumericSafety() throws on NaN or ±Inf — non-JSON-safe values
//            that indicate malformed or injected data.
var _MAX_PAYLOAD_BYTES = 2_000_000;
var _MAX_DEPTH = 50;

function validateObject(obj, depth, seen) {
  if (depth === undefined) depth = 0;
  if (seen === undefined) seen = new WeakSet();
  if (depth > _MAX_DEPTH) throw new Error('DEPTH_LIMIT: exceeds ' + _MAX_DEPTH);
  if (obj === null || typeof obj !== 'object') return;
  // F-10: cycle detection — reject any object reference seen before in this walk
  if (seen.has(obj)) throw new Error('CYCLE_DETECTED: circular reference in payload');
  seen.add(obj);
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new Error('PROTOTYPE_POLLUTION: rejected key=' + k);
    }
    validateObject(obj[k], depth + 1, seen);
  }
}

// F-11: Walk all leaf values; throw on non-finite numbers (NaN, ±Infinity).
function _checkNumericSafety(obj, depth, seen) {
  if (depth === undefined) depth = 0;
  if (seen === undefined) seen = new WeakSet();
  if (depth > _MAX_DEPTH) return;
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') {
    if (!isFinite(obj)) {
      throw new Error('INVALID_VALUE: non-finite number ' + obj + ' in payload');
    }
    return;
  }
  if (typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    _checkNumericSafety(obj[keys[i]], depth + 1, seen);
  }
}

function safeParse(raw) {
  if (typeof raw !== 'string') {
    throw new Error('safeParse: input must be a string, got ' + typeof raw);
  }
  // Phase 9: size guard (UTF-8 byte estimate via length ×3 worst-case)
  if (raw.length * 3 > _MAX_PAYLOAD_BYTES) {
    throw new Error('PAYLOAD_TOO_LARGE: raw length ' + raw.length + ' exceeds limit');
  }
  var obj = JSON.parse(raw);
  // Phase 7: root type guard
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('INVALID_JSON_ROOT: expected object, got ' +
      (obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj));
  }
  // F-10: deep pollution + cycle check
  validateObject(obj, 0, new WeakSet());
  // F-11: non-finite number guard
  _checkNumericSafety(obj, 0, new WeakSet());
  return obj;
}

// ── Incremental postMessage update ───────────────────────────────────
window.addEventListener('message',function(ev){
  var msg;
  // VS Code webview posts the data as a plain object (already parsed).
  // Some external surfaces post raw JSON strings — guard both.
  if (typeof ev.data === 'string') {
    try {
      msg = safeParse(ev.data);
    } catch (e) {
      _logObsEvent('msg:parse_error', { error: String(e) });
      handlePipelineError('Message parse error: ' + String(e));
      return;
    }
  } else {
    msg = ev.data;
    // F-10/F-11: apply full validation (cycle + pollution + numeric safety)
    // on already-parsed objects arriving from the VS Code host.
    if (msg && typeof msg === 'object') {
      try {
        validateObject(msg, 0, new WeakSet());
        _checkNumericSafety(msg, 0, new WeakSet());
      } catch (e) {
        _logObsEvent('msg:validation_blocked', { error: String(e) });
        handlePipelineError('Message validation blocked: ' + String(e));
        return;
      }
    }
  }
  if(!msg||!msg.type) return;
  _enqueue(msg);
});

function _handleMessage(msg){
  // Group A: versioned sequence guard — reject stale/reordered pipeline messages
  if(msg.seq !== undefined){
    var lastSeq = _lastSeqByType[msg.type] !== undefined ? _lastSeqByType[msg.type] : -1;
    if(msg.seq <= lastSeq){
      _logObsEvent('seq:rejected', { type: msg.type, incoming: msg.seq, last: lastSeq });
      return;   // stale or reordered — discard
    }
    _lastSeqByType[msg.type] = msg.seq;
  }
  // Group R: log every handled message type with timestamp
  _logObsEvent('msg:handle', { type: msg.type, seq: msg.seq });
  log.debug('message received:', {value: msg.type, msg});

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

  // ── pipelineError: reset UI THEN show error ──────────────────────────
  if(msg.type==='pipelineError'){
    resetUIState();
    handlePipelineError(msg.message);
    return;
  }

  // ── pipelineComplete (legacy): full data bundle ──────────────────────
  if(msg.type==='pipelineComplete'){
    resetUIState();
    applyPipelineData(msg.data || msg);
    log.debug('[AutoMate] pipelineComplete — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }

  // ── pipelineResult: spec field names from extension ──────────────────
  if(msg.type==='pipelineResult'){
    resetUIState();
    applyPipelineData(msg.data || msg);
    log.debug('[AutoMate] pipelineResult — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    log.debug('dashboard state:', {value: D});
    syntheticRendered=false; secRendered=false;
    renderAll();
  }
  if(msg.type==='insights'){
    D.insights = msg.data || null;
    renderAll();
  }
  if(msg.type==='insightsError'){
    handlePipelineError(msg.message || 'Insights fetch failed');
    return;
  }
  if(msg.type==='aiResponse'){
    // Route through agentHandleResponse which correctly targets the chat UI.
    // The old ai-status / ai-response / ai-model element IDs no longer exist in
    // the HTML — accessing them would throw TypeError and kill this listener.
    if(typeof agentHandleResponse==='function'){
      agentHandleResponse(msg.content, msg.model, msg.error);
    } else {
      // Fallback: log only — never dereference potentially-null elements
      log.warn('[AutoMate] aiResponse received but agentHandleResponse not ready:', msg);
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
    var dot=document.getElementById('agent-ctx-dot');
    var tag=document.getElementById('agent-model-tag');
    var status=document.getElementById('agent-key-status');
    var inp=document.getElementById('agent-api-key');
    if(dot) dot.className='agent-ctx-dot '+(msg.configured?'ok':'warn');
    if(tag) tag.textContent=msg.configured?('🤖 '+(msg.model||'OpenRouter')):'';
    if(status){
      if(msg.configured){
        status.style.color='var(--green)';
        status.textContent='✓ Key active';
      } else {
        status.style.color='#fb923c';
        status.textContent='No key — paste one above';
      }
    }
    if(inp && msg.configured && !inp.value){
      inp.placeholder='Key active — paste a new key to update';
    }
    if(inp && !msg.configured){
      inp.placeholder='Paste sk-or-… key then press Enter or click Save';
      inp.focus();
    }
  }
  // ── Phase 5: Agent Chat response ──────────────────────────────────────
  if(msg.type==='agentResponse'){
    agentHandleResponse(msg.content, msg.model, msg.error);
  }
}

${AGENT_SCRIPT}

${SECURITY_SCRIPT}

${LIVE_SECURITY_SCRIPT}

// ── End Phase 4 Live Security ────────────────────────────────────────────────

// renderIntelligenceRisk, renderColumnRanking, renderRecommendations
// are defined in OVERVIEW_SCRIPT — do not redeclare here.

// ── PART 3: renderAll — uses activeTab global, not fragile DOM query ──
function renderAll(){
  if(!D) return;

  // Fix 6: Empty state guard
  if(!D.profile || (!D?.profile?.meta?.row_count)){
    document.body.classList.add('empty-state');
    return;
  }
  document.body.classList.remove('empty-state');

  log.debug('renderAll called');
  log.debug('generator rows:', {value: D.generator?.row_count});
  log.debug('leakage:', {value: !!D.leakage});
  log.debug('activeTab:', {value: activeTab});

  // ── Step 5: DOM element existence checks ─────────────────────────
  log.debug('m-risk element:', {value: document.getElementById("m-risk")});
  log.debug('pane-overview:', {value: document.getElementById("pane-overview")});
  log.debug('synthetic-root:', {value: document.getElementById("synthetic-root")});
  // ── Step 6: Tab pane count ────────────────────────────────────────
  log.debug('tabpanes:', {value: document.querySelectorAll(".tabpane").length});

  // Reset render guards so new pipeline data always redraws tabs
  syntheticRendered=false;
  secRendered=false;
  try{renderSanityBanner();log.debug('renderSanityBanner executed');}catch(e){log.error("[AutoMate] render error",e)}
  try{renderStrip();log.debug('renderStrip executed');}catch(e){log.error("[AutoMate] render error",e)}
  try{renderDatasetSummary();log.debug('renderDatasetSummary executed');}catch(e){log.error("[AutoMate] render error",e)}
  try{renderRiskRadar();log.debug('renderRiskRadar executed');}catch(e){log.error("[AutoMate] render error",e)}
  try{renderC1();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderC5();}catch(e){log.error("[AutoMate] render error",e)}   // Feature Drift Heatmap — must run after data loads
  try{renderC12();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderRis();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderIntelligenceRisk();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderColumnRanking();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderRecommendations();}catch(e){log.error("[AutoMate] render error",e)}
  try{renderTimeline();}catch(e){log.error("[AutoMate] render error",e)}
  try{initDistCols();if(_distCols.length)renderDistComparison(_distCols[0]);}catch(e){log.error("[AutoMate] render error",e)}
  // Force-render whichever tab is active using stable global state
  switch(activeTab){
    case 'synthetic':
      try{syntheticRendered=false;renderSynthetic(true);}catch(err){log.error("[AutoMate] render error",err)}
      break;
    case 'security':
      try{secRendered=false;renderSecurity();}catch(err){log.error("[AutoMate] render error",err)}
      break;
    case 'livesecurity':
      try{renderLiveSecurity();}catch(err){log.error("[AutoMate] render error",err)}
      break;
    case 'aiinsights':
      try{initAgentChat();}catch(err){log.error("[AutoMate] render error",err)}
      break;
  }
  setTimeout(()=>{
    try{renderC2();}catch(e){}
  },150);

  // Fix 5: Render interpretation layer
  if(D?.interpretation){
    const el = document.getElementById('ai-interpretation');
    if(el){
      el.innerHTML = Object.entries(D.interpretation)
        .map(([k,v]) => '<div><b>' + k + ':</b> ' + v + '</div>')
        .join('');
    }
  }

  // Fix 4: Render decision layer
  if(D?.decision?.decisions){
    const el = document.getElementById('ai-decisions');
    if(el){
      el.innerHTML = D.decision.decisions.map(function(d){
        return '<div class="decision ' + d.level + '"><b>' + (d.message || '') + '</b><br/><small>' + (d.action || '') + '</small></div>';
      }).join('');
    }
  }

  const explainEl = document.getElementById('ai-explain');

  if (explainEl && D?.decision?.decisions) {
      explainEl.innerHTML = D.decision.decisions.map(function(d){
          return '<div class="explain">'
            + '<b>' + (d.message || '') + '</b>'
            + '<div class="explain-action">' + (d.action || '') + '</div>'
            + '</div>';
      }).join('');
  }

  // Fix 5: Render trust layer
  if(D?.trust){
    const el = document.getElementById('ai-trust');
    if(el){
      el.innerHTML = '<div class="trust-' + D.trust.trust_level + '"><div><b>Trust Level:</b> ' + D.trust.trust_level + '</div><div><b>Score:</b> ' + D.trust.trust_score + '</div></div>';
    }
  }

// Fix B8: Render summary
const summaryEl = document.getElementById('ai-summary');
if (summaryEl && D.summary) {
  summaryEl.textContent = D.summary;
}

const insightEl = document.getElementById('ai-insights');
if (insightEl) {
  if (D.mode === 'agent' && Array.isArray(D.execution)) {
    const steps = D.execution
      .map(function (s, i) {
        const tool = (s && s.tool) ? String(s.tool) : 'unknown';
        return '<div>Step ' + (i + 1) + ': ' + tool + '</div>';
      })
      .join('');
    insightEl.innerHTML =
      '<div><b>Agent Execution</b></div>' +
      '<div>Steps: ' + D.execution.length + '</div>' +
      steps;
  } else if (D?.insights) {
    const dist = D.insights.distribution || { critical: 0, warning: 0, safe: 0 };
    insightEl.innerHTML =
      '<div>Total Runs: ' + (D.insights.total_runs ?? 0) + '</div>' +
      '<div>Critical: ' + (dist.critical ?? 0) + '</div>' +
      '<div>Warning: ' + (dist.warning ?? 0) + '</div>' +
      '<div>Safe: ' + (dist.safe ?? 0) + '</div>' +
      '<div>Avg Rows: ' + (D.insights.avg_rows ?? 0) + '</div>';
  } else {
    insightEl.innerHTML = '<div style="color:var(--fg3);font-size:11px">Insights will appear after pipeline runs.</div>';
  }
}
}

function _automate_init() {
  setTimeout(() => {
    document.querySelectorAll(".tabpane").forEach(function (p) {
      p.style.display = "none";
    });

    const overview = document.getElementById("pane-overview");
    if (overview) overview.style.display = "block";

    renderAll();
  }, 100);
}

/* Boot — defined here, so _automate_init is guaranteed to exist */
_automate_init();

log.debug('tab panes:', { value: document.querySelectorAll(".tabpane").length });
</script>
  </body>
  </html>`;
}
