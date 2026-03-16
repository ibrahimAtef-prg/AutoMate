"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
//# sourceMappingURL=livesecurity.js.map