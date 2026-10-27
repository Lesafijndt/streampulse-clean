import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShuffleQueueTransition, buildUnshuffleQueueTransition, queueRequestKey } from '../src/queueShuffle.js';

test('unshuffle restores surviving original requests, preserves pinned slots and appends new generations', () => {
  const original = ['a', 'pin', 'b', 'c'].map((id, i) => ({ id, timestamp: 1, status: 'queue', queueOrder: (i + 1) * 1000, pinned: id === 'pin' }));
  const snapshot = original.map(queueRequestKey);
  const shuffled = buildShuffleQueueTransition(original, () => 0).nextVideos;
  const restored = buildUnshuffleQueueTransition(shuffled, snapshot).nextVideos;
  assert.deepEqual(restored.sort((a, b) => a.queueOrder - b.queueOrder).map(row => row.id), ['a', 'pin', 'b', 'c']);
  const later = [...shuffled.filter(row => row.id !== 'a'), { id: 'a', timestamp: 2, status: 'queue', queueOrder: 5000 }, { id: 'live', status: 'playing' }];
  const transition = buildUnshuffleQueueTransition(later, snapshot);
  assert.equal(transition.updates.has('live'), false);
  const queue = transition.nextVideos.filter(row => row.status === 'queue').sort((a, b) => a.queueOrder - b.queueOrder);
  assert.equal(queue.at(-1).id, 'a', 'rerequested generation must not reuse the old original slot');
  assert.equal(queue.findIndex(row => row.id === 'pin'), 1);
});

test('shuffle conserves requests, keeps pinned slots and changes only waiting queueOrder', () => {
  const videos = [
    { id: 'c', status: 'queue', queueOrder: 3000, url: 'https://example.com/c', title: 'C', audioOnly: true },
    { id: 'a', status: 'queue', queueOrder: 1000, title: 'A' },
    { id: 'pin', status: 'queue', queueOrder: 2000, pinned: true, upvotes: 99 },
    { id: 'd', status: 'queue', queueOrder: 4000, title: 'D' },
    { id: 'playing', status: 'playing', queueOrder: 7, audioOnly: true },
    { id: 'history', status: 'watched', queueOrder: 8 },
    { id: 'later', status: 'watch_later', queueOrder: 9 }
  ];
  const original = structuredClone(videos);
  const { nextVideos, updates } = buildShuffleQueueTransition(videos, () => 0);
  assert.deepEqual(videos, original, 'input must not be mutated');
  assert.deepEqual(nextVideos.map((item) => item.id).sort(), videos.map((item) => item.id).sort());
  assert.deepEqual(nextVideos.filter((item) => item.status === 'queue').sort((a, b) => a.queueOrder - b.queueOrder).map((item) => item.id), ['c', 'pin', 'd', 'a']);
  assert.equal(nextVideos.find((item) => item.id === 'pin').queueOrder, 2000);
  assert.equal(updates.has('pin'), false);
  for (const item of nextVideos) {
    const prior = videos.find((video) => video.id === item.id);
    if (prior.status !== 'queue') assert.equal(item, prior);
    const { queueOrder, ...rest } = item;
    const { queueOrder: previousOrder, ...previousRest } = prior;
    assert.deepEqual(rest, previousRest);
  }
  for (const fields of updates.values()) assert.deepEqual(Object.keys(fields), ['queueOrder']);
});

test('identity shuffle produces no unnecessary writes for normalized ranks', () => {
  const videos = [{ id: 'a', status: 'queue', queueOrder: 1000 }, { id: 'b', status: 'queue', queueOrder: 2000 }];
  const result = buildShuffleQueueTransition(videos, () => 0.999);
  assert.equal(result.updates.size, 0);
  assert.deepEqual(result.nextVideos, videos);
  assert.equal(buildShuffleQueueTransition([]).updates.size, 0);
});

test('legacy timestamps establish initial pinned slots and normalize ranks', () => {
  const videos = [{ id: 'late', status: 'queue', timestamp: 30 }, { id: 'pin', status: 'queue', timestamp: 20, pinned: true }, { id: 'early', status: 'queue', timestamp: 10 }];
  const result = buildShuffleQueueTransition(videos, () => 0);
  assert.deepEqual(result.nextVideos.slice().sort((a, b) => a.queueOrder - b.queueOrder).map((item) => item.id), ['late', 'pin', 'early']);
  assert.deepEqual(result.updates.get('pin'), { queueOrder: 2000 });
});

 test('fair shuffle gives each normalized requester a turn while preserving playback, pins, and undo', () => {
 const videos = ['a','a','a','b','c','b'].map((owner,i)=>({id:String(i),requestedBy:i===1?'@A':owner,status:'queue',timestamp:1,queueOrder:(i+1)*1000}));
 videos.push({id:'live',status:'playing',requestedBy:'a'}, {id:'pin',status:'queue',pinned:true,queueOrder:7000});
 const before=structuredClone(videos), original=videos.filter(v=>v.status==='queue').map(queueRequestKey);
 const result=buildShuffleQueueTransition(videos,()=>0.999,true);
 assert.deepEqual(videos,before);
 const waiting=result.nextVideos.filter(v=>v.status==='queue').sort((a,b)=>a.queueOrder-b.queueOrder);
 assert.deepEqual(waiting.map(v=>v.id),['0','3','4','1','5','2','pin']);
 assert.deepEqual(result.nextVideos.find(v=>v.id==='live'),before.find(v=>v.id==='live'));
 assert.equal(waiting.at(-1).id,'pin');
 assert.deepEqual(buildUnshuffleQueueTransition(result.nextVideos,original).nextVideos.filter(v=>v.status==='queue').sort((a,b)=>a.queueOrder-b.queueOrder).map(v=>v.id),original.map(key=>key.split(':')[0]));
 });
test('shuffle, fair shuffle and unshuffle preserve fully and partly promoted positions',()=>{
 const videos=Array.from({length:7},(_,index)=>({id:String(index),status:'queue',timestamp:100+index,queueOrder:(index+1)*1000,requestedBy:index%2?'alice':'bob',...(index===0||index===3?{promotion:{version:2,state:'active',points:index===0?450:50,requestTimestamp:100+index}}:{})}));
 videos.push({id:'live',status:'playing',timestamp:1,playedAt:123,url:'https://youtu.be/live'});
 const original=structuredClone(videos),snapshot=videos.filter(row=>row.status==='queue').map(queueRequestKey).reverse();
 for(const result of [buildShuffleQueueTransition(videos,()=>0),buildShuffleQueueTransition(videos,()=>0,true),buildUnshuffleQueueTransition(videos,snapshot)]){
  const waiting=result.nextVideos.filter(row=>row.status==='queue').sort((a,b)=>a.queueOrder-b.queueOrder);
  assert.equal(waiting[0].id,'0');assert.equal(waiting[3].id,'3');assert.equal(result.updates.has('0'),false);assert.equal(result.updates.has('3'),false);
  assert.deepEqual(result.nextVideos.find(row=>row.id==='live'),original.at(-1));assert.deepEqual(waiting.map(row=>row.id).sort(),['0','1','2','3','4','5','6']);
 }
 assert.deepEqual(videos,original);
});
