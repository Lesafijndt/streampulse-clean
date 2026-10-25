import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresStore } from '../server/postgres-store.js';
import { persistChatCommand } from '../server/chat-commands.js';
const before=process.env.VITE_FIREBASE_NAMESPACE;
const namespace='command-verification-'+randomUUID();process.env.VITE_FIREBASE_NAMESPACE=namespace;
const db=await getPostgresStore(namespace),prefix=`artifacts/${namespace}/public/data/`;
let replies=0;
try{
  for(const[id,status,by,queueOrder]of[['playing','playing','owner',0],['first','queue','other',1],['own','queue','ordinary_viewer',2]]){
    await db.doc(prefix+'queue_videos/'+id).set({id,channelRoom:'2o3a',status,requestedBy:by,title:id,queueOrder,timestamp:queueOrder,url:'https://youtu.be/dQw4w9WgXcQ',voters:[],upvotes:0});
  }
  const run=(text,messageId,login='ordinary_viewer',badges=[])=>persistChatCommand(db,{event:{broadcaster_user_login:'2o3a',chatter_user_login:login,badges:badges.map(set_id=>({set_id})),message:{text}},messageId},{sendReply:async()=>{replies++;return{sent:true}}});
  await run('!vote 1','vote');await run('!vote 1','vote');
  assert.equal((await db.doc(prefix+'queue_videos/first').get()).get('upvotes'),1);
  await run('!remove','remove');assert.equal((await db.doc(prefix+'queue_videos/own').get()).exists,false);
  await run('!skip','denied');assert.equal((await db.doc(prefix+'queue_videos/playing').get()).get('status'),'playing');
  await run('!skip','skip','trusted_mod',['moderator']);assert.equal((await db.doc(prefix+'queue_videos/first').get()).get('status'),'playing');
  await run('!volume 50','volume','2o3a');
  assert.equal((await db.doc(prefix+'room_settings/2o3a').get()).get('chatCommandFeed')[0].volumeCommand.value,50);
  assert.equal(replies,2);
  console.log(JSON.stringify({check:'live_chat_commands',ok:true,vote:true,ownRemoval:true,staffSkip:true,viewerSkipDenied:true,audioFeed:true,idempotent:true,publicChatMessagesSent:0}));
}finally{
  const state=await db.readState();await db.commitOperations(Object.keys(state.documents).map(path=>({type:'delete',path})));
  if(before===undefined)delete process.env.VITE_FIREBASE_NAMESPACE;else process.env.VITE_FIREBASE_NAMESPACE=before;
}
// Check existing grants read-only; never issue a chat-send call from this diagnostic.
const id=process.env.TWITCH_CLIENT_ID,secret=process.env.TWITCH_CLIENT_SECRET;
if(id&&secret){
  const token=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:id,client_secret:secret,grant_type:'client_credentials'}),signal:AbortSignal.timeout(5000)}).then(r=>r.json());
  const headers={'Client-Id':id,Authorization:'Bearer '+token.access_token};
  const users=await fetch('https://api.twitch.tv/helix/users?login=gachibot69&login=2o3a',{headers,signal:AbortSignal.timeout(5000)}).then(r=>r.json());
  const query=new URLSearchParams();for(const user of users.data||[])query.append('user_id',user.id);
  const response=await fetch('https://api.twitch.tv/helix/authorization/users?'+query,{headers,signal:AbortSignal.timeout(5000)});
  const grants=await response.json();
  console.log(JSON.stringify({check:'chat_authorization',status:response.status,users:(grants.data||[]).map(row=>({login:row.user_login,authorized:row.has_authorized,chatWrite:row.scopes?.includes('user:write:chat'),userBot:row.scopes?.includes('user:bot'),channelBot:row.scopes?.includes('channel:bot')}))}));
}
