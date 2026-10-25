// Optional live-provider test. Starts only its own isolated headless Chrome.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getClipPlayback } from '../server/twitch-clip-playback.js';
const source = await getClipPlayback(new URL('https://www.twitch.tv/xqc/clip/CulturedAmazingKuduDatSheffy-TiZ_-ixAGYR3y2Uy'));
assert.equal(source.mode, 'direct');
const cache = fileURLToPath(new URL('../node_modules/.cache/live-browser-', import.meta.url));
await mkdir(fileURLToPath(new URL('../node_modules/.cache/', import.meta.url)), { recursive: true });
const profile = await mkdtemp(cache);
const processHandle = spawn(process.env.CHROME_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
let socket;let serial=0;const pending=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  let port;
  for(let i=0;i<100&&!port;i++){try{port=Number((await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0])}catch{await sleep(100)}}
  assert.ok(port,'Chrome debugging endpoint did not start');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  socket.onmessage=event=>{const message=JSON.parse(event.data);const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(Error(message.error.message)):request.resolve(message.result)}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value};
  const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(100)}throw Error('Live browser condition timed out: '+expression+' '+JSON.stringify(await evaluate('window.clipState?.()')))};
  const toggleNativePlayer=async()=>{
    await evaluate('document.querySelector("video").focus()');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  };
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:(process.env.WHALE_CUM_TEST_BASE_URL||'http://127.0.0.1:5192')+'/tests/browser/live-native-twitch.html'});
  await until('typeof window.initClip === "function"');
  await evaluate('window.initClip('+JSON.stringify(source)+')');
  await until('window.clipState().ready>=2');
  await until('!window.clipState().paused || window.clipState().button === "Play clip"');
  if((await evaluate('window.clipState()')).paused)await toggleNativePlayer();
  await until('window.clipState().time>0.2 && !window.clipState().paused');
  assert.equal((await evaluate('window.clipState()')).volume,.5);
  await evaluate('document.querySelector("video").currentTime=20');
  await until('window.clipState().time>=20');await toggleNativePlayer();
  await until('window.clipState().paused');await sleep(400);
  const paused=await evaluate('window.clipState()');
  await evaluate('window.remountClip()');
  await until('window.clipState().ready>=2 && window.clipState().time>=19.5');
  const restored=await evaluate('window.clipState()');assert.equal(restored.paused,true);assert.ok(Math.abs(restored.time-paused.time)<1);assert.equal(restored.volume,.5);
  await toggleNativePlayer();await until('!window.clipState().paused');
  await evaluate('document.querySelector("video").currentTime=document.querySelector("video").duration-.5');
  await until('window.clipState().ended===1');await sleep(400);
  assert.equal((await evaluate('window.clipState()')).ended,1);
  console.log(JSON.stringify({check:'live_native_twitch',ok:true,realCdnVideo:true,nativePlayerPauseResume:true,userGestureAutoplayRecovery:true,volume50:true,pausedPositionRestored:true,realEndedOnce:true}));
} finally {socket?.close();processHandle.kill();}
