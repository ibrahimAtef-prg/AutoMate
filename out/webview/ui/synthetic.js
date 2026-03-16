"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
//# sourceMappingURL=synthetic.js.map