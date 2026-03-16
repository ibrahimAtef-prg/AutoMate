"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
.agent-config-select{background:var(--card);border:1px solid rgba(251,146,60,.4);border-radius:7px;color:var(--fg);font-size:11px;padding:5px 8px;outline:none;cursor:pointer;min-width:150px}
.agent-config-select:focus{border-color:#fb923c}
.agent-config-input{flex:1;min-width:180px;max-width:320px;background:var(--card);border:1px solid rgba(251,146,60,.4);border-radius:7px;color:var(--fg);font-size:11px;padding:5px 10px;outline:none}
.agent-config-input:focus{border-color:#fb923c}
.agent-config-btn{padding:5px 12px;background:rgba(251,146,60,.18);border:1px solid rgba(251,146,60,.45);border-radius:7px;color:#fb923c;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap}
.agent-config-btn:hover{background:rgba(251,146,60,.30)}
.agent-config-ok{font-size:10px;color:var(--green);margin-left:4px}
.agent-config-status,.agent-config [id="agent-key-status"]{font-size:10px;margin-left:4px;font-weight:500}

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
  const maxReid = reidVals.length ? Math.max.apply(null, reidVals.map(Number)) * 100 : 0;
  
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
//# sourceMappingURL=charts.js.map