import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl=process.env.WHALE_CUM_TEST_BASE_URL||'http://127.0.0.1:5173';

test('dashboard mounts in desktop and mobile browser viewports without crashing',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1365,height:900}});
  const pageErrors=[];page.on('pageerror',(error)=>pageErrors.push(error.message));
  await page.goto(baseUrl,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#root > *',{timeout:15000});await page.waitForTimeout(500);
  const desktop=await page.locator('#root').evaluate(node=>({childCount:node.childElementCount,textLength:(node.innerText||'').trim().length}));
  assert.ok(desktop.childCount>0,'React should mount a visible application shell');
  assert.ok(desktop.textLength>0,'the application shell should not be blank');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
  const mobile=await page.locator('#root').evaluate(node=>({width:node.getBoundingClientRect().width,viewport:window.innerWidth}));
  assert.ok(mobile.width<=mobile.viewport+1,'root should fit a phone viewport');
  assert.deepEqual(pageErrors,[],'the dashboard should not throw uncaught browser exceptions');
 }finally{await browser.close();}
});

test('provider command bridge sends correctly shaped YouTube and TikTok messages',async()=>{
 const browser=await chromium.launch({headless:true});
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
