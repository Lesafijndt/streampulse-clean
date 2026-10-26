import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { bufferRequest, consumeRequest } from '../server/durable-intake.js';
import { metadataCachePath } from '../server/cached-media-metadata.js';
const before = process.env.VITE_FIREBASE_NAMESPACE, namespace = 'reliability-' + randomUUID();
process.env.VITE_FIREBASE_NAMESPACE = namespace;
const db = await getPostgresStore(namespace), prefix = `artifacts/${namespace}/public/data/`;
const api = async (body, login = 'paim_beach_pete', view) => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handlePrivateStore({ method: body ? 'POST' : 'GET', query: { view }, body,
    headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app' } }, res, { login }, { db, namespace, random: () => 0 }); return res;
};
try {
  for (const [id,status,queueOrder] of [['a','queue',1000],['b','queue',2000],['live','playing',0]]) await db.doc(prefix+'queue_videos/'+id).set({id,status,queueOrder,channelRoom:'2o3a',timestamp:1,url:'https://youtu.be/abcdefghijk',title:id});
  const playing = (await db.doc(prefix+'queue_videos/live').get()).data();
  assert.equal((await api({operation:'shuffle',expectedVersion:await db.getVersion()},'2o3a')).code,200);
  assert.equal((await api(null,'2o3a','recovery')).code,403);
  const snapshot=(await api(null,'paim_beach_pete','recovery')).body.snapshots[0];
  await db.doc(prefix+'queue_videos/new').set({id:'new',channelRoom:'2o3a',status:'queue',timestamp:2,queueOrder:9999,url:'https://youtu.be/zyxwvutsrqp',title:'New arrival'});
  await db.doc(prefix+'queue_videos/a').update({title:'Later title',upvotes:9});
  assert.equal((await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'})).body.restored,2);
  assert.equal((await db.doc(prefix+'queue_videos/a').get()).get('title'),'Later title');
  assert.equal((await db.doc(prefix+'queue_videos/a').get()).get('upvotes'),9);
  assert.ok((await db.doc(prefix+'queue_videos/new').get()).exists);
  assert.deepEqual((await db.doc(prefix+'queue_videos/live').get()).data(),playing);
  const url='https://youtu.be/dQw4w9WgXcQ';let payload,calls=0;
  await bufferRequest({event:{broadcaster_user_login:'2o3a',chatter_user_login:'verification_viewer',message:{text:url}},messageId:'metadata-'+randomUUID()}, {send:async(topic,value)=>{payload=value}});
  // Use a valid Twitch login length in the synthetic notification.
  // No message is sent to Twitch or the production durable queue.
  const dependencies={db,metadataProvider:async()=>({title:'Verified background title',durationSec:++calls===1?null:213,durationProvider:'acceptance-provider'}),sendReply:async()=>{throw Error('Unexpected public chat reply')}};
  await assert.rejects(consumeRequest(payload,dependencies),error=>error.code==='metadata_retry_pending');
  await db.doc(metadataCachePath(url)).update({nextAt:0});
  const result=await consumeRequest(payload,dependencies);assert.equal(result.status,'duplicate_delivery');
  const rows=await db.collection(prefix+'queue_videos').get();
  const requested=rows.docs.filter(doc=>doc.data().url===url);assert.equal(requested.length,1);assert.equal(requested[0].data().durationSec,213);
  console.log(JSON.stringify({check:'live_reliability_acceptance',ok:true,moderatorOnlyRecovery:true,selectiveUndo:true,newArrivalsPreserved:true,playingUnchanged:true,metadataRetryAfterSave:true,noDuplicateRequest:true,chatMessagesSent:0}));
} finally {
  const state=await db.readState();await db.commitOperations(Object.keys(state.documents).map(path=>({type:'delete',path})));
  if(before===undefined)delete process.env.VITE_FIREBASE_NAMESPACE;else process.env.VITE_FIREBASE_NAMESPACE=before;
}
