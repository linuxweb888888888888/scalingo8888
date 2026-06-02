// singlefile.js - Complete SHIB HTX Growth Bot with Paper Trading (Under 500 lines)
require('dotenv').config();
const express=require('express'),cron=require('node-cron'),ccxt=require('ccxt');
const app=express(),PAPER=process.env.PAPER_TRADING==='true',PORT=process.env.PORT||3000;
app.use(express.json());

// Paper Trading Engine (compact)
class Paper{constructor(b=1e3){this.balance=b;this.initial=b;this.positions=[];this.closed=[]}
async buy(q,p,r){let c=q*p;if(c>this.balance)return{ok:false};
let pos={id:Date.now(),entry:p,qty:q,cost:c,time:Date.now(),reason:r};
this.positions.push(pos);this.balance-=c;console.log(`📝 BUY ${q.toFixed(2)}@${p.toFixed(8)} | Bal:${this.balance.toFixed(2)}`);return{ok:true,pos};}
async sell(pos,p,r){let rev=pos.qty*p,pnl=rev-pos.cost,roi=(pnl/pos.cost)*100;
pos.exit=p;pos.exitTime=Date.now();pos.pnl=pnl;pos.roi=roi;pos.reason=r;
this.closed.push(pos);this.balance+=rev;this.positions=this.positions.filter(x=>x.id!=pos.id);
console.log(`📝 SELL PnL:${pnl.toFixed(4)} (${roi.toFixed(2)}%) | Bal:${this.balance.toFixed(2)}`);return{pnl,roi};}
summary(price){let inv=this.positions.reduce((s,p)=>s+p.cost,0),val=this.balance+this.positions.reduce((s,p)=>s+p.qty*price,0);
return{bal:this.balance,init:this.initial,inv,val,realized:this.closed.reduce((s,p)=>s+p.pnl,0),unrealized:val-this.balance-inv,total:val-this.initial,winRate:this.closed.length?this.closed.filter(p=>p.pnl>0).length/this.closed.length*100:0};}
reset(b=1e3){this.balance=b;this.initial=b;this.positions=[];this.closed=[];}}

let paper=PAPER?new Paper(process.env.INITIAL_PAPER_BALANCE||1e3):null,exchange=PAPER?null:new ccxt.htx({apiKey:process.env.HTX_API_KEY,secret:process.env.HTX_API_SECRET,password:process.env.HTX_API_PASSPHRASE,enableRateLimit:true});
let active=[],closed=[],dca=[],running=true,priceHistory=[],totalPnL=0,totalInv=0;
let rates={morning:{en:true,rate:.5,hours:'06:00-12:00',label:'🌅 Morning'},afternoon:{en:true,rate:.3,hours:'12:00-18:00',label:'☀️ Afternoon'},evening:{en:true,rate:.2,hours:'18:00-00:00',label:'🌙 Evening'},night:{en:false,rate:.1,hours:'00:00-06:00',label:'🌃 Night'}};

function getRate(){let now=new Date(),h=now.getHours(),m=now.getMinutes(),t=h*60+m;
for(let p of Object.values(rates)){if(!p.en)continue;let[sH,sM]=p.hours.split('-')[0].split(':'),[eH,eM]=p.hours.split('-')[1].split(':'),sT=parseInt(sH)*60+parseInt(sM),eT=parseInt(eH)*60+parseInt(eM),cT=t<eT&&t>=sT?t:t+1440;
if(cT>=sT&&cT<(eT< sT?eT+1440:eT))return p.rate;}return .2;}

async function getPrice(){if(PAPER){let last=priceHistory[priceHistory.length-1]?.price||.0000085;return Math.max(.000005,Math.min(.000015,last+(Math.random()-.5)*.0000002));}
try{return(await exchange.fetchTicker(process.env.SYMBOL)).last;}catch(e){return null;}}

async function buy(amt,reason){let price=await getPrice();if(!price)return null;let qty=amt/price;
if(PAPER){let r=await paper.buy(qty,price,reason);if(!r.ok)return null;
let pos={id:r.pos.id,entry:price,qty,amt,time:Date.now(),dca:dca.length,reason};active.push(pos);totalInv+=amt;return pos;}
try{let order=await exchange.createMarketBuyOrder(process.env.SYMBOL,qty);let pos={id:order.id,entry:price,qty,amt,time:Date.now(),dca:dca.length,reason};active.push(pos);totalInv+=amt;return pos;}catch(e){return null;}}

async function sell(pos,reason){let price=await getPrice();if(!price)return null;let pnl,roi;
if(PAPER){let p=paper.positions.find(p=>p.id==pos.id);if(!p)return null;let r=await paper.sell(p,price,reason);pnl=r.pnl;roi=r.roi;}else{let rev=price*pos.qty;pnl=rev-pos.amt;roi=(pnl/pos.amt)*100;await exchange.createMarketSellOrder(process.env.SYMBOL,pos.qty);}
pos.exit=price;pos.exitTime=Date.now();pos.pnl=pnl;pos.roi=roi;pos.reason=reason;closed.push(pos);totalPnL+=pnl;active=active.filter(p=>p.id!=pos.id);console.log(`💸 SELL PnL:${pnl.toFixed(4)} (${roi.toFixed(2)}%)`);return{pnl,roi};}

async function check(){if(active.length==0)return;let price=await getPrice();if(!price)return;
let totalQty=active.reduce((s,p)=>s+p.qty,0),totalAmt=active.reduce((s,p)=>s+p.amt,0),avgEntry=totalAmt/totalQty,growth=((price-avgEntry)/avgEntry)*100,target=getRate();
priceHistory.push({time:Date.now(),price,growth,target});if(priceHistory.length>500)priceHistory.shift();
if(growth>=target){console.log(`🎯 Target ${target}% reached! Selling...`);for(let p of[...active])await sell(p,`Target ${target}%`);dca=[];}
else if(growth<parseFloat(process.env.ROI_THRESHOLD||-10)&&dca.length<parseInt(process.env.MAX_DCA_LEVELS||5)){let mult=parseFloat(process.env.DCA_MULTIPLIER||1.2),prev=dca.length?dca[dca.length-1].amt:parseFloat(process.env.BASE_ORDER_AMOUNT||10),newAmt=prev;dca.push({lvl:dca.length+1,amt:newAmt,price,time:Date.now()});await buy(newAmt,`DCA Lvl${dca.length} ROI${growth.toFixed(2)}%`);}}

cron.schedule('*/30 * * * * *',async()=>{if(running)await check();});

// Routes (compact)
app.get('/api/status',async(req,res)=>{let price=await getPrice(),rate=getRate(),totalQty=active.reduce((s,p)=>s+p.qty,0),totalAmt=active.reduce((s,p)=>s+p.amt,0),avg=totalAmt/totalQty,roi=totalAmt?((price-avg)/avg)*100:0,pnl=totalAmt?(price*totalQty)-totalAmt:0;
res.json({mode:PAPER?'paper':'live',running,price,rate,activeCount:active.length,active,inv:totalInv,pnl:totalPnL,avgEntry:avg,currentROI:roi,currentPnL:pnl,closedCount:closed.length,paperSummary:PAPER?paper.summary(price):null,dca,rates,history:priceHistory.slice(-100)});});
app.get('/api/closed',(req,res)=>res.json(closed.sort((a,b)=>b.exitTime-a.exitTime)));
app.get('/api/pnl',(req,res)=>{let win=closed.filter(t=>t.pnl>0),loss=closed.filter(t=>t.pnl<0);res.json({total:closed.length,wins:win.length,losses:loss.length,winRate:closed.length?(win.length/closed.length*100).toFixed(2):0,totalPnL,avgWin:win.length?win.reduce((s,t)=>s+t.pnl,0)/win.length:0,avgLoss:loss.length?loss.reduce((s,t)=>s+t.pnl,0)/loss.length:0,best:win.length?Math.max(...win.map(t=>t.pnl)):0,worst:loss.length?Math.min(...loss.map(t=>t.pnl)):0,roi:totalInv?(totalPnL/totalInv*100).toFixed(2):0});});
app.post('/api/rate',(req,res)=>{let{p,en,rate,h}=req.body;if(rates[p])rates[p]={...rates[p],en,rate,h};res.json({ok:true});});
app.post('/api/start',(req,res)=>{running=true;res.json({ok:true});});
app.post('/api/stop',(req,res)=>{running=false;res.json({ok:true});});
app.post('/api/buy',async(req,res)=>{let pos=await buy(req.body.amt||10,req.body.reason||'Manual');res.json({ok:!!pos,pos});});
app.post('/api/sell',async(req,res)=>{if(!active.length)return res.json({ok:false});for(let p of[...active])await sell(p,'Manual');dca=[];res.json({ok:true});});
app.post('/api/reset',(req,res)=>{active=[];closed=[];dca=[];totalPnL=0;totalInv=0;priceHistory=[];res.json({ok:true});});
if(PAPER){app.post('/api/deposit',(req,res)=>{paper.balance+=req.body.amt;res.json({bal:paper.balance});});app.post('/api/withdraw',(req,res)=>{if(req.body.amt<=paper.balance)paper.balance-=req.body.amt;res.json({bal:paper.balance});});app.post('/api/paper-reset',(req,res)=>{paper.reset(req.body.bal||1e3);active=[];closed=[];dca=[];totalPnL=0;totalInv=0;res.json({ok:true});});}

// HTML Dashboard (embedded)
app.get('/',(req,res)=>res.send(`<!DOCTYPE html><html><head><title>SHIB Bot ${PAPER?'📝':'🔴'}</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{background:linear-gradient(135deg,#0a0e27,#1a1f3a);color:#fff;font-family:monospace;padding:20px}.container{max-width:1400px;margin:0 auto}h1{color:#00d4ff;margin-bottom:20px}.badge{padding:5px 15px;border-radius:20px;font-size:12px;background:${PAPER?'#ff9800':'#4caf50'}}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px;margin-bottom:20px}.card{background:rgba(255,255,255,.1);border-radius:10px;padding:20px;backdrop-filter:blur(10px)}.card h3{color:#00d4ff;margin-bottom:15px}.stat{display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid rgba(255,255,255,.1)}.positive{color:#0f0}.negative{color:#f44}button{background:#00d4ff;color:#000;border:none;padding:10px 20px;margin:5px;cursor:pointer;border-radius:5px;font-weight:bold}button.danger{background:#f44}button.warning{background:#fa0}table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid rgba(255,255,255,.1)}.refresh{position:fixed;bottom:20px;right:20px;background:#00d4ff;width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer}</style></head><body><div class="container"><h1>🚀 SHIB HTX Bot <span class="badge">${PAPER?'PAPER MODE':'LIVE MODE'}</span></h1><div class="grid"><div class="card"><h3>📊 Status</h3><div id="status"></div></div><div class="card"><h3>💰 PnL</h3><div id="pnl"></div></div><div class="card"><h3>⚙️ Settings</h3><div id="settings"></div></div><div class="card"><h3>🎮 Controls</h3><button onclick="start()">▶️ Start</button><button onclick="stop()" class="danger">⏸️ Stop</button><button onclick="buy()">💰 Buy 10 USDT</button><button onclick="sell()" class="warning">💸 Sell All</button><button onclick="reset()">🔄 Reset</button>${PAPER?'<button onclick="paperControl()" class="success">📝 Paper</button>':''}</div></div><div class="card"><h3>📈 Price Chart</h3><canvas id="chart" height="200"></canvas></div><div class="card"><h3>🎯 Active (<span id="acnt">0</span>)</h3><div id="active"></div></div><div class="card"><h3>✅ Closed (<span id="ccnt">0</span>)</h3><div id="closed" style="max-height:300px;overflow:auto"></div></div></div><div class="refresh" onclick="refresh()">🔄</div><script>let chart;async function refresh(){let s=await(await fetch('/api/status')).json(),p=await(await fetch('/api/pnl')).json(),c=await(await fetch('/api/closed')).json();
document.getElementById('status').innerHTML=\`<div class="stat"><span>Status:</span><span>\${s.running?'🟢 Running':'🔴 Stopped'}</span></div><div class="stat"><span>Price:</span><span>\${(s.price*1e6).toFixed(2)} (x1M)</span></div><div class="stat"><span>Target:</span><span>\${s.rate}%</span></div><div class="stat"><span>Active:</span><span>\${s.activeCount}</span></div><div class="stat"><span>Current ROI:</span><span class="\${s.currentROI>=0?'positive':'negative'}">\${s.currentROI.toFixed(2)}%</span></div><div class="stat"><span>Current PnL:</span><span class="\${s.currentPnL>=0?'positive':'negative'}">\${s.currentPnL.toFixed(4)} USDT</span></div>\`;
if(s.paperSummary)document.getElementById('pnl').innerHTML=\`<div class="stat"><span>Balance:</span><span>\${s.paperSummary.bal.toFixed(2)} USDT</span></div><div class="stat"><span>Total PnL:</span><span class="\${s.paperSummary.total>=0?'positive':'negative'}">\${s.paperSummary.total.toFixed(4)} USDT</span></div><div class="stat"><span>Realized:</span><span>\${s.paperSummary.realized.toFixed(4)}</span></div><div class="stat"><span>Win Rate:</span><span>\${s.paperSummary.winRate.toFixed(1)}%</span></div>\`;
else document.getElementById('pnl').innerHTML=\`<div class="stat"><span>Total Trades:</span><span>\${p.total}</span></div><div class="stat"><span>Win Rate:</span><span>\${p.winRate}%</span></div><div class="stat"><span>Total PnL:</span><span class="\${p.totalPnL>=0?'positive':'negative'}">\${p.totalPnL.toFixed(4)} USDT</span></div><div class="stat"><span>ROI:</span><span class="\${p.roi>=0?'positive':'negative'}">\${p.roi}%</span></div>\`;
document.getElementById('settings').innerHTML=Object.entries(s.rates).map(([k,v])=>'<div><label>'+v.label+'</label><input type="range" min="0" max="2" step="0.1" value="'+v.rate+'" onchange="setRate(\''+k+'\',this.value)" '+(v.en?'':'disabled')+'><span>'+v.rate+'%</span><label><input type="checkbox" '+(v.en?'checked':'')+' onchange="toggle(\''+k+'\',this.checked)"> Enabled</label></div>').join('');
document.getElementById('acnt').innerText=s.active.length;document.getElementById('active').innerHTML=s.active.length?'<table><tr><th>Time</th><th>Price</th><th>Amt</th><th>Reason</th></tr>'+s.active.map(p=>'<tr><td>'+new Date(p.time).toLocaleTimeString()+'</td><td>'+(p.entry*1e6).toFixed(2)+'</td><td>'+p.amt.toFixed(2)+'</td><td>'+p.reason+'</td></tr>').join('')+'</table>':'<p>📭 No active positions</p>';
document.getElementById('ccnt').innerText=c.length;document.getElementById('closed').innerHTML=c.length?'<table><tr><th>Time</th><th>Entry</th><th>Exit</th><th>PnL</th><th>ROI</th></tr>'+c.slice(0,30).map(t=>'<tr><td>'+new Date(t.exitTime).toLocaleTimeString()+'</td><td>'+(t.entry*1e6).toFixed(2)+'</td><td>'+(t.exit*1e6).toFixed(2)+'</td><td class="'+(t.pnl>=0?'positive':'negative')+'">'+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'</td><td class="'+(t.roi>=0?'positive':'negative')+'">'+(t.roi>=0?'+':'')+t.roi.toFixed(2)+'%</td></tr>').join('')+'</table>':'<p>📭 No closed trades</p>';
if(s.history&&s.history.length){let ctx=document.getElementById('chart').getContext('2d');if(chart)chart.destroy();chart=new Chart(ctx,{type:'line',data:{labels:s.history.map(h=>new Date(h.time).toLocaleTimeString()),datasets:[{label:'Growth %',data:s.history.map(h=>h.growth),borderColor:'#0f0',tension:.4},{label:'Target %',data:s.history.map(h=>h.target),borderColor:'#00d4ff',borderDash:[5,5],tension:.4}]}});}}
async function setRate(p,r){await fetch('/api/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p,en:true,rate:parseFloat(r)})});refresh();}
async function toggle(p,en){await fetch('/api/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p,en,rate:.5})});refresh();}
async function start(){await fetch('/api/start',{method:'POST'});refresh();}
async function stop(){await fetch('/api/stop',{method:'POST'});refresh();}
async function buy(){await fetch('/api/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amt:10})});refresh();}
async function sell(){if(confirm('Sell all?')){await fetch('/api/sell',{method:'POST'});refresh();}}
async function reset(){if(confirm('Reset all data?')){await fetch('/api/reset',{method:'POST'});refresh();}}
${PAPER?`async function paperControl(){let amt=prompt('Deposit amount (USDT):');if(amt)await fetch('/api/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amt:parseFloat(amt)})});refresh();}`:''}
refresh();setInterval(refresh,3000);</script></body></html>`));

app.listen(PORT,()=>console.log(`\n🚀 SHIB Bot running on http://localhost:${PORT}\n📝 Mode: ${PAPER?'PAPER TRADING':'LIVE TRADING'}\n`));
