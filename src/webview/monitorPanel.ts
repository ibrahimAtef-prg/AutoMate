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

import { DashboardState } from './types/dashboard';
import { CHART_INLINE_FALLBACK_SCRIPT, DASHBOARD_STYLES, RISK_RADAR_SCRIPT } from './ui/charts';
import { OVERVIEW_TAB_HTML, OVERVIEW_SCRIPT } from './ui/overview';
import { SYNTHETIC_TAB_HTML, SYNTHETIC_SCRIPT } from './ui/synthetic';
import { SECURITY_TAB_HTML, SECURITY_SCRIPT } from './ui/security';
import { LIVE_SECURITY_TAB_HTML, LIVE_SECURITY_SCRIPT } from './ui/livesecurity';
import { AGENT_TAB_HTML, AGENT_SCRIPT } from './ui/agent';

export interface DashboardData {
  result: any;   // generator output  {samples, row_count, generator_used, ...}
  leakage: any;   // leakage_bridge output — full contract
  ast: any;   // parse.py AST
  baseline: any;   // baseline.py artifact {meta, columns, correlations, ...}
  cp: any;   // checkpoint data
  checkpoint: any;   // alias for cp
  chartUri: string;
  // Spec-field aliases (used by pipelineResult message handler)
  generator?: any;   // alias for result — carries .samples, .row_count, .generator_used
  profile?: any;   // alias for baseline — carries .columns, .meta
  intelligence?: any;   // reserved for future intelligence module output
  // Governance modules
  scanReport?: any;   // data_scanner.py PII scan results
  attackReport?: any;   // attack_simulator.py results
  knowledgeGraph?: any;   // knowledge_graph.py entity graph
  lineage?: any;   // lineage.py data lineage record
  // New: Part 1 & 2 fields surfaced from pipeline
  dataset_risk_score?: number;    // 0-100 composite risk (in leakage object)
  pii_columns?: string[];  // columns flagged by pii_detector
}

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

${OVERVIEW_TAB_HTML}
${SYNTHETIC_TAB_HTML}
${SECURITY_TAB_HTML}
${LIVE_SECURITY_TAB_HTML}
${AGENT_TAB_HTML}

<script>
console.log("[AutoMate] webview script loaded");
const vscode = acquireVsCodeApi();
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
};
D = Object.assign(D, ${dataJson} || {});
if(!D.generator && D.result) D.generator = D.result;
if(!D.profile && D.baseline) D.profile = D.baseline;

// ── Stable global tab state ──────────────────────────────────────────
let activeTab = 'overview';

// ── updateDashboardState — single source of truth for D mutations ──
function updateDashboardState(d){
  if(!d) return;
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
  if(d.leakage)                    D.leakage        = d.leakage;
  if(d.scanReport)                 D.scanReport     = d.scanReport;
  if(d.intelligence !== undefined) D.intelligence   = d.intelligence;
  if(d.ast          !== undefined) D.ast            = d.ast;
  if(d.attackReport !== undefined) D.attackReport   = d.attackReport;
  if(d.knowledgeGraph !== undefined) D.knowledgeGraph = d.knowledgeGraph;
  if(d.lineage      !== undefined) D.lineage        = d.lineage;
  if(d.cp           !== undefined) D.cp             = d.cp;
  // Ensure mirrors stay consistent
  if(!D.generator && D.result)   D.generator = D.result;
  if(!D.profile   && D.baseline) D.profile   = D.baseline;
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

// ── Incremental postMessage update ───────────────────────────────────
window.addEventListener('message',function(ev){
  var msg=ev.data;
  if(!msg||!msg.type) return;
  console.log('[AutoMate] message received:', msg.type, msg);

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
    updateDashboardState(msg.data || msg);
    console.log('[AutoMate] pipelineComplete — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }

  // ── pipelineResult: spec field names from extension ──────────────────
  if(msg.type==='pipelineResult'){
    updateDashboardState(msg.data || msg);
    console.log('[AutoMate] pipelineResult — rows:', (D.generator||D.result||{}).row_count,
      'leakage:', !!D.leakage, 'scan:', !!D.scanReport);
    console.log('[AutoMate] dashboard state:', D);
    syntheticRendered=false; secRendered=false;
    renderAll();
  }
  if(msg.type==='aiResponse'){
    // Route through agentHandleResponse which correctly targets the chat UI.
    // The old ai-status / ai-response / ai-model element IDs no longer exist in
    // the HTML — accessing them would throw TypeError and kill this listener.
    if(typeof agentHandleResponse==='function'){
      agentHandleResponse(msg.content, msg.model, msg.error);
    } else {
      // Fallback: log only — never dereference potentially-null elements
      console.warn('[AutoMate] aiResponse received but agentHandleResponse not ready:', msg);
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
});

${AGENT_SCRIPT}

${SECURITY_SCRIPT}

${LIVE_SECURITY_SCRIPT}

// ── End Phase 4 Live Security ────────────────────────────────────────────────

// renderIntelligenceRisk, renderColumnRanking, renderRecommendations
// are defined in OVERVIEW_SCRIPT — do not redeclare here.

// ── PART 3: renderAll — uses activeTab global, not fragile DOM query ──
function renderAll(){
  console.log("[AutoMate] renderAll called");
  console.log("[AutoMate] generator rows:", D.generator?.row_count);
  console.log("[AutoMate] leakage:", !!D.leakage);
  console.log("[AutoMate] activeTab:", activeTab);

  // ── Step 5: DOM element existence checks ─────────────────────────
  console.log("[AutoMate] m-risk element:", document.getElementById("m-risk"));
  console.log("[AutoMate] pane-overview:", document.getElementById("pane-overview"));
  console.log("[AutoMate] synthetic-root:", document.getElementById("synthetic-root"));
  // ── Step 6: Tab pane count ────────────────────────────────────────
  console.log("[AutoMate] tabpanes:", document.querySelectorAll(".tabpane").length);

  // Reset render guards so new pipeline data always redraws tabs
  syntheticRendered=false;
  secRendered=false;
  try{renderSanityBanner();console.log("[AutoMate] renderSanityBanner executed");}catch(e){console.error("[AutoMate] render error",e)}
  try{renderStrip();console.log("[AutoMate] renderStrip executed");}catch(e){console.error("[AutoMate] render error",e)}
  try{renderDatasetSummary();console.log("[AutoMate] renderDatasetSummary executed");}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRiskRadar();console.log("[AutoMate] renderRiskRadar executed");}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC1();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderC5();}catch(e){console.error("[AutoMate] render error",e)}   // Feature Drift Heatmap — must run after data loads
  try{renderC12();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRis();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderIntelligenceRisk();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderColumnRanking();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderRecommendations();}catch(e){console.error("[AutoMate] render error",e)}
  try{renderTimeline();}catch(e){console.error("[AutoMate] render error",e)}
  try{initDistCols();if(_distCols.length)renderDistComparison(_distCols[0]);}catch(e){console.error("[AutoMate] render error",e)}
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
    document.querySelectorAll(".tabpane").forEach(function(p){
      p.style.display = "none";
    });

    const overview = document.getElementById("pane-overview");
    if(overview) overview.style.display = "block";

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
