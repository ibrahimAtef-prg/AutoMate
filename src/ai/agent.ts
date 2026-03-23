export const AGENT_TAB_HTML = String.raw`
<!-- TAB: AI Insights (Phase 5 — Agent Chat) -->
<div id="pane-aiinsights" class="tabpane">
  <div id="agent-root">
  <!-- Context status bar -->
  <div class="agent-ctx-bar">
    <div class="agent-ctx-dot" id="agent-ctx-dot"></div>
    <span id="agent-ctx-label">No dataset loaded — run the pipeline first for grounded responses</span>
    <span style="margin-left:auto;color:var(--fg3)" id="agent-model-tag"></span>
  </div>
  <!-- API key config — always visible -->
  <div class="agent-config" id="agent-config-row">
    <label>🔑 OpenRouter API Key</label>
    <input class="agent-config-input" id="agent-api-key" type="password"
      placeholder="Paste sk-or-… key then press Enter or click Save"
      onkeydown="if(event.key==='Enter') agentSaveKey()" />
    <button class="agent-config-btn" onclick="agentSaveKey()">Save</button>
    <button class="agent-config-btn" id="agent-clear-btn" onclick="agentClearKey()" style="background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.4);color:#f87171" title="Remove saved key">Clear</button>
    <span class="agent-config-ok" id="agent-config-ok" style="display:none">✓ Saved</span>
    <span id="agent-key-status" style="font-size:10px;margin-left:4px"></span>
    <a href="https://openrouter.ai/keys" style="color:#fb923c;font-size:10px;text-decoration:underline;margin-left:auto" target="_blank">Get free key ↗</a>
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

export const AGENT_SCRIPT = String.raw`
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
  /* log.debug( */ (void 0) && ('[AutoMate] agentChat request:', text);
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
  if(!root){ log.error('initAgentChat: missing root container #agent-root'); return; }
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
  // Restore saved API key silently — let apiKeyStatus response set the label
  try{
    var savedKey=localStorage.getItem('automate_api_key');
    if(savedKey && savedKey.trim().length > 8){
      // Send to extension — extension will reply with apiKeyStatus which sets the label
      vscode.postMessage({command:'setApiKey',apiKey:savedKey});
    }
  }catch(e){}
  // Always ask extension for current key status — this drives the status label
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
  // Persist to localStorage so it survives panel reloads
  try{ localStorage.setItem('automate_api_key', key); }catch(e){}
  // Send to extension so OpenRouterClient can use it immediately
  vscode.postMessage({command:'setApiKey', apiKey:key});
  // Show ✓ Saved feedback briefly, then show masked key in status label
  var ok=document.getElementById('agent-config-ok');
  if(ok){ ok.style.display=''; setTimeout(function(){ ok.style.display='none'; },2000); }
  var status=document.getElementById('agent-key-status');
  var masked=key.slice(0,8)+'…'+key.slice(-4);
  if(status){ status.style.color='var(--green)'; status.textContent='✓ Active: '+masked; }
  inp.value='';
  inp.placeholder='Key saved — paste a new key to update';
  // Re-query extension so context bar updates
  vscode.postMessage({command:'checkApiKey'});
}

function agentClearKey(){
  try{ localStorage.removeItem('automate_api_key'); }catch(e){}
  vscode.postMessage({command:'clearApiKey'});
  var inp=document.getElementById('agent-api-key');
  var status=document.getElementById('agent-key-status');
  var dot=document.getElementById('agent-ctx-dot');
  if(inp){ inp.value=''; inp.placeholder='Paste sk-or-… key then press Enter or click Save'; inp.focus(); }
  if(status){ status.style.color='#fb923c'; status.textContent='Key cleared'; }
  if(dot) dot.className='agent-ctx-dot warn';
}

function agentInitCtxBar(){
  var dot   = document.getElementById('agent-ctx-dot');
  var label = document.getElementById('agent-ctx-label');
  var inp   = document.getElementById('agent-api-key');
  var status= document.getElementById('agent-key-status');
  if(!dot||!label) return;

  // Send stored key to extension silently — apiKeyStatus response will update the label
  try{
    var savedKey = localStorage.getItem('automate_api_key');
    if(savedKey && savedKey.trim().length > 8){
      vscode.postMessage({command:'setApiKey', apiKey:savedKey});
    }
  }catch(e){}

  // Ask extension — apiKeyStatus response is the single source of truth for the label
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
    var errLow = error ? error.toLowerCase() : '';
    var isKeyError = errLow.indexOf('api key')!==-1
      || errLow.indexOf('not configured')!==-1
      || errLow.indexOf('authentication')!==-1
      || errLow.indexOf('unauthorized')!==-1
      || errLow.indexOf('invalid key')!==-1
      || errLow.indexOf('invalid api')!==-1
      || error.indexOf('401')!==-1;
    if(isKeyError){
      // Focus the key input row (always visible) and update its status label
      var inp2=document.getElementById('agent-api-key');
      var status2=document.getElementById('agent-key-status');
      if(inp2) inp2.focus();
      if(status2){ status2.style.color='#fb923c'; status2.textContent='No key — paste one above'; }
      var keyMsg='🔑 API key not configured. Paste your OpenRouter key in the bar above and press Enter.';
      _agentHistory.push({role:'assistant',content:keyMsg,ts:ts});
      addAgentMessage(keyMsg);
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
  /* log.debug( */ (void 0) && ("[AutoMate] model response received");
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
