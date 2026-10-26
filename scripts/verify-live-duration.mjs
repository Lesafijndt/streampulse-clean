import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
  const until=async expression=>{for(let i=0;i<260;i++){if(await evaluate(expression))return;await sleep(100)}throw Error('Live browser condition timed out: '+expression+' '+JSON.stringify(await evaluate('window.clipState?.()')))};
  const toggleNativePlayer=async()=>{
    await evaluate('document.querySelector("video").focus()');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  };
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:(process.env.WHALE_CUM_TEST_BASE_URL||'http://127.0.0.1:5192')+'/tests/browser/live-duration-probe.html'});
  await until('window.durationResult !== undefined');
  const seconds=await evaluate('window.durationResult');
  assert.ok(seconds >= 636 && seconds <= 637);
  console.log(JSON.stringify({check:'live_youtube_cued_duration',seconds,autoplay:false,ok:true}));
}finally{socket?.close();processHandle.kill();}
