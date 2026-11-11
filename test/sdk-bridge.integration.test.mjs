import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createBridge } from '../packages/bridge/dist/server.mjs';
import { createClient } from '../packages/browser/dist/index.js';

function tab(origin, port) {
  let current=new URL(`${origin}/feature?mode=summary#original`);
  let navigation;
  const saved=new Map();
  const location={get href(){return current.href},get origin(){return current.origin},get hash(){return current.hash},assign(url){navigation=url},replace(url){current=new URL(url,current)}};
  const history={state:null,replaceState(_state,_title,url){current=new URL(url,current)}};
  const sessionStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value)),removeItem:key=>saved.delete(key)};
  const browserFetch=(url,init={})=>fetch(url,{...init,headers:{...init.headers,Origin:origin}});
  const client=createClient({bridgeUrl:`http://127.0.0.1:${port}`,fetch:browserFetch,location,history,sessionStorage,crypto:webcrypto});
  return {client,get navigation(){return navigation},arrive(url){current=new URL(url)},get href(){return current.href}};
}
async function approveTab(context, localOrigin) {
  await context.client.pair();
  const page=await fetch(context.navigation,{headers:{'Sec-Fetch-Dest':'document'}});
  assert.equal(page.status,200);
  const text=await page.text();
  const csrf=text.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(csrf);
  const answer=await fetch(`${localOrigin}/v1/pair/approve`,{
    method:'POST',redirect:'manual',headers:{Origin:localOrigin,'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,decision:'allow'})
  });
  assert.equal(answer.status,303);
  context.arrive(answer.headers.get('location'));
  assert.deepEqual(await context.client.completePairing(),{paired:true});
}

test('a website can approve its origin and add an AI feature without sharing another site’s session',async t=>{
  const calls=[];
  const bridge=createBridge({port:0,getProviders:()=>[{id:'codex',available:true}],
    runProvider:async request=>{calls.push({provider:request.provider,message:request.message,history:request.history});return {provider:request.provider,reply:'A short summary.'};}});
  const address=await bridge.listen();t.after(async()=>{await bridge.close()});
  const localOrigin=`http://127.0.0.1:${address.port}`;
  const first=tab('https://first.example',address.port), second=tab('https://second.example',address.port);
  await approveTab(first,localOrigin);
  assert.equal(first.href,'https://first.example/feature?mode=summary#original');
  assert.equal((await first.client.status()).connected,true);
  assert.equal((await second.client.status()).connected,false);
  assert.deepEqual(await first.client.generate({provider:'codex',input:'Summarize the example text.'}),{provider:'codex',output:'A short summary.'});
  assert.deepEqual(calls,[{provider:'codex',message:'Summarize the example text.',history:[]}]);
  await approveTab(second,localOrigin);
  await first.client.disconnect();
  assert.equal((await first.client.status()).connected,false);
  assert.equal((await second.client.status()).connected,true);
  assert.deepEqual(await second.client.generate({provider:'codex',input:'Another text'}),{provider:'codex',output:'A short summary.'});
});
