export const SECURITY_TAB_HTML = String.raw`
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

export const SECURITY_SCRIPT = String.raw`
// ── Security tab rendering ───────────────────────────────────────────
let secRendered=false;
function renderSecurity(){
  if(secRendered)return;
  /* log.debug( */ (void 0) && ('[AutoMate] rendering security tab');
  const root=document.getElementById('security-root');
  if(!root){ log.error('initAgentChat: missing root container #agent-root'); return; }
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
