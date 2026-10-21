import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl=process.env.WHALE_CUM_TEST_BASE_URL||'http://127.0.0.1:5173';
async function launchTestBrowser() {
 const options={headless:true};
 if(process.env.CHROME_EXECUTABLE_PATH) options.executablePath=process.env.CHROME_EXECUTABLE_PATH;
 return chromium.launch(options);
}

test('dashboard mounts in desktop and mobile browser viewports without crashing',async()=>{
 const browser=await launchTestBrowser();
 try{
  const page=await browser.newPage({viewport:{width:1365,height:900}});
  const pageErrors=[],consoleErrors=[],failedRequests=[],badResponses=[];
  page.on('pageerror',(error)=>pageErrors.push(error.stack||error.message));
  page.on('console',(message)=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('requestfailed',(request)=>failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
  page.on('response',async(response)=>{if(response.status()>=400){const body=await response.text().catch(()=> '');badResponses.push({url:response.url(),status:response.status(),body:body.slice(0,5000)});}});
  await page.goto(baseUrl,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2000);
  const desktop=await page.locator('#root').evaluate(node=>({childCount:node.childElementCount,textLength:(node.innerText||'').trim().length,html:node.innerHTML.slice(0,1600)}));
  assert.ok(desktop.childCount>0&&desktop.textLength>0,
    'React should mount a visible application shell. ' + JSON.stringify({desktop,pageErrors,consoleErrors,failedRequests,badResponses}));
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
  const mobile=await page.locator('#root').evaluate(node=>({width:node.getBoundingClientRect().width,viewport:window.innerWidth}));
  assert.ok(mobile.width<=mobile.viewport+1,'root should fit a phone viewport');
  assert.deepEqual(pageErrors,[],'the dashboard should not throw uncaught browser exceptions: '+JSON.stringify({consoleErrors,badResponses}));
 }finally{await browser.close();}
});

test('provider command bridge sends correctly shaped YouTube and TikTok messages',async()=>{
 const browser=await launchTestBrowser();
 try{
  const page=await browser.newPage();
  await page.goto(`${baseUrl}/tests/browser/player-bridge.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__playerFixtureReady===true);
  for(const button of ['#yt-play','#yt-pause','#tt-play','#tt-pause','#tt-mute','#tt-unmute']) await page.locator(button).click();
  const commands=await page.evaluate(()=>window.__playerCommands);
  assert.equal(commands.length,6);
  assert.equal(commands[0].origin,'https://www.youtube.com');
  assert.deepEqual(JSON.parse(commands[0].data),{event:'command',func:'playVideo',args:[]});
  assert.deepEqual(JSON.parse(commands[1].data),{event:'command',func:'pauseVideo',args:[]});
  assert.equal(commands[2].origin,'https://www.tiktok.com');
  assert.deepEqual(commands.slice(2).map(entry=>entry.data.type),['play','pause','mute','unMute']);
  assert.ok(commands.slice(2).every(entry=>entry.data['x-tiktok-player']===true&&entry.data.value===null));
 }finally{await browser.close();}
});
