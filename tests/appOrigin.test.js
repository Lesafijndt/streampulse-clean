import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAppOrigin, requestRedirectUri } from '../server/app-origin.js';
import login from '../api/twitch/login.js';
test('both production hosts keep OAuth state and callback on the same host', async t => {
 const saved={url:process.env.TWITCH_APP_URL,redirect:process.env.TWITCH_REDIRECT_URI,id:process.env.TWITCH_CLIENT_ID};
 t.after(()=>{for(const [key,value] of [['TWITCH_APP_URL',saved.url],['TWITCH_REDIRECT_URI',saved.redirect],['TWITCH_CLIENT_ID',saved.id]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.TWITCH_APP_URL='https://203a.vercel.app';process.env.TWITCH_REDIRECT_URI='https://203a.vercel.app/api/twitch/callback';process.env.TWITCH_CLIENT_ID='test';
 for(const host of ['203a.vercel.app','streampulse-clean.vercel.app']) {
  const req={method:'GET',headers:{host},query:{}};const headers={};let target;
  await login(req,{setHeader:(k,v)=>{headers[k]=v},getHeader:k=>headers[k],redirect:(code,url)=>{assert.equal(code,302);target=new URL(url)}});
  assert.equal(target.searchParams.get('redirect_uri'),'https://'+host+'/api/twitch/callback');
  assert.ok(String(headers['Set-Cookie']).includes(target.searchParams.get('state')));
  assert.equal(requestAppOrigin(req),'https://'+host);
 }
 assert.equal(requestRedirectUri({headers:{host:'attacker.example','x-forwarded-host':'203a.vercel.app'}}),'https://203a.vercel.app/api/twitch/callback');
 assert.equal(requestAppOrigin({headers:{host:'203a.vercel.app.attacker.example'}}),'https://203a.vercel.app');
});
