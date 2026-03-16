export const OVERVIEW_TAB_HTML = String.raw`
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

export const OVERVIEW_SCRIPT = String.raw`
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
