import { kv } from './assistant.js';
import { gas } from './books.js';
import { recordPush } from './usage.js';
export function receivableWeek(now){const t=new Date(now+8*3600e3);return t.getUTCDay()===1&&t.getUTCHours()>=9?t.toISOString().slice(0,10):null;}
export function receivableText(r){const fmt=n=>(n/100).toLocaleString('zh-TW',{maximumFractionDigits:2});return '待收款提醒｜共有 '+r.items.length+' 筆，尚欠 NT$'+fmt(r.total)+'\n'+r.items.slice(0,20).map(x=>'・'+x.person+'：NT$'+fmt(x.remaining)+'（'+x.date+' '+String(x.reason).slice(0,50)+'）').join('\n')+(r.items.length>20?'\n其餘請至 APP 查看。':'')+'\n收到款項後，請在「代墊／應收款」登記收款，收清後就不再提醒。\n'+r.url;}
export async function receivableRecipient(env,db){const a=await kv.json(db,'admins',[]);if(a.length!==1||!/^U[0-9a-f]{32}$/i.test(a[0]))throw Error('應收款提醒需要確認唯一個人管理員');return a[0];}
export async function receivablesTick(env,db,now){try{await reserveTick(env,db,now)}catch(e){console.log('reserve tick',e.message)}const week=receivableWeek(now);if(!week)return 0;const key='ar:weekly:'+week;let state=await kv.json(db,key,null);if(state?.sent||state?.empty)return 0;if(state?.attempt&&now-state.attempt<300000)return 0;const to=await receivableRecipient(env,db),r=await gas(env,'personalReceivables');if(!r?.ok||!Array.isArray(r.items))throw Error('應收款摘要讀取失敗');if(!r.items.length){await kv.set(db,key,JSON.stringify({empty:true,at:now}));return 0;}if(state?.to&&state.to!==to)throw Error('提醒收件人已變更，需重新確認');
 if(!state){const proposed={to,retry:crypto.randomUUID(),attempt:0};await db.prepare('INSERT OR IGNORE INTO line_kv(k,v) VALUES(?,?)').bind(key,JSON.stringify(proposed)).run();state=await kv.json(db,key,null);}const old=JSON.stringify(state),next={...state,attempt:now};const claim=await db.prepare('UPDATE line_kv SET v=? WHERE k=? AND v=?').bind(JSON.stringify(next),key,old).run();if(!claim.meta?.changes)return 0;
 const res=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+env.LINE_CHANNEL_TOKEN,'X-Line-Retry-Key':state.retry},body:JSON.stringify({to,messages:[{type:'text',text:receivableText(r)}]})});
 if(!res.ok&&!(res.status===409&&res.headers.get('x-line-accepted-request-id')))throw Error('應收款 LINE 提醒傳送失敗：'+res.status);await kv.set(db,key,JSON.stringify({...next,sent:true,at:now}));await recordPush(db,to,1);return 1;
}
export function reservePlan(s,r){
 if(!r?.ready)return {kind:'idle'};
 if(!Number.isSafeInteger(r.balance)||r.threshold!==5000000||!r.openingId||r.company!=='玖陸好運')throw Error('預備金摘要無效');
 if(!s||s.openingId!==r.openingId)s={openingId:r.openingId,low:false,zero:false};
 if(r.balance>=5000000)return {kind:'reset',state:{openingId:r.openingId,low:false,zero:false}};
 const kind=r.balance<=0?'zero':'low';if(s[kind])return {kind:'idle'};
 return {kind,state:s,balance:r.balance};
}
export async function reserveTick(env,db,now){
 const response=await gas(env,'personalReceivables');if(!response?.ok)throw Error('預備金讀取失敗');
 const r=response.reserve;if(!r?.ready)return 0;
 const key='reserve:玖陸:v1';let s=await kv.json(db,key,null);const original=JSON.stringify(s);if(s?.attempt&&now-s.attempt<300000)return 0;
 const p=reservePlan(s,r);if(p.kind==='idle')return 0;
 if(p.kind==='reset'){if(s&&(s.low||s.zero||s.pending))await db.prepare('UPDATE line_kv SET v=? WHERE k=? AND v=?').bind(JSON.stringify(p.state),key,original).run();return 0;}
 const to=await receivableRecipient(env,db);if(s?.to&&s.to!==to)throw Error('預備金提醒收件人變更');
 if(s?.pending&&s.pending!==p.kind)s={...s,pending:null,retry:null,started:null};
 const next={...p.state,to,pending:p.kind,retry:s?.retry||crypto.randomUUID(),started:s?.started||now,attempt:now};
 if(now-next.started>23*3600e3)throw Error('預備金提醒超過安全重試時間，需檢查送達紀錄');
 if(original==='null'){await db.prepare('INSERT OR IGNORE INTO line_kv(k,v) VALUES(?,?)').bind(key,JSON.stringify({openingId:r.openingId,low:false,zero:false})).run();return 0;}
 const claim=await db.prepare('UPDATE line_kv SET v=? WHERE k=? AND v=?').bind(JSON.stringify(next),key,original).run();if(!claim.meta?.changes)return 0;
 const text='玖陸預備金提醒｜'+(p.kind==='zero'?'已用完，請向公司請款':'低於 5 萬元，請準備向公司請款')+'\n目前可用：NT$'+(p.balance/100).toLocaleString('zh-TW')+'\n私人卡公司費用已扣預備金，繳卡費不再扣。\n'+response.url.replace('mode=personal','mode=company');
 const res=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+env.LINE_CHANNEL_TOKEN,'X-Line-Retry-Key':next.retry},body:JSON.stringify({to,messages:[{type:'text',text}]})});
 if(!res.ok&&!(res.status===409&&res.headers.get('x-line-accepted-request-id')))throw Error('預備金提醒傳送失敗：'+res.status);
 await kv.set(db,key,JSON.stringify({...p.state,to,low:true,zero:p.kind==='zero'||p.state.zero,pending:null,retry:null,started:null,attempt:0,sentAt:now}));await recordPush(db,to,1);return 1;
}
