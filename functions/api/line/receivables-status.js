import { currentUser, json } from "../../../lib/auth.js";
import { gas } from "../../../lib/books.js";
import { kv } from "../../../lib/assistant.js";
import { receivableRecipient } from "../../../lib/receivables.js";
import { lineClient } from "../../../lib/line.js";
export async function onRequestGet({request,env}) {
 const u=await currentUser(request,env.DB);
 if(!u||u.email!=="benwu0317@gmail.com")return json({ok:false,error:"unauthorized"},401);
 try {
 const to=await receivableRecipient(env,env.DB);
 const name=await lineClient(env.LINE_CHANNEL_TOKEN).name(to,to);
 const r=await gas(env,"personalReceivables");
 if(!r?.ok||!Array.isArray(r.items))throw Error("應收摘要未連通");
 const last=Number(await kv.get(env.DB,"tick:last"))||0;
 return json({ok:true,recipientName:name,summaryConnected:true,outstandingCount:r.items.length,schedule:"每週一 09:00 Asia/Taipei",lastTick:last?new Date(last).toISOString():null});
 }catch(e){return json({ok:false,error:e.message},503);}
}
