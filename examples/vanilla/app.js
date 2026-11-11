import { createClient } from '/sdk.js';

const client = createClient();
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
const form = document.querySelector('#summarize');
const provider = document.querySelector('#provider');
const input = document.querySelector('#input');
const submit = document.querySelector('#submit');
const result = document.querySelector('#result');
const output = document.querySelector('#output');
let ready = false;
let busy = false;

function showError(error) { status.textContent = error?.message || 'Could not connect to the local bridge.'; }
function setReady(value) {
  ready=value; input.disabled=!value||busy; provider.disabled=!value||busy; submit.disabled=!value||busy;
  disconnect.hidden=!value;
}
async function updateStatus(existingState) {
  try {
    const state=existingState ?? await client.status(); setReady(state.connected);
    if (!state.connected) { status.textContent='Bridge found. Choose Connect AI to approve this website.'; return; }
    const available=new Set(state.providers.filter(item=>item.available).map(item=>item.id));
    for (const option of provider.options) option.disabled=!available.has(option.value);
    const first=[...provider.options].find(option=>!option.disabled);
    if(first) provider.value=first.value;
    else { setReady(false); disconnect.hidden=false; status.textContent='Connected, but no provider is enabled. Check your local bridge configuration.'; return; }
    status.textContent='Connected to your local bridge.';
  } catch (error) { setReady(false); status.textContent='Start the local bridge, then choose Connect AI. '+(error?.message||''); }
}
connect.addEventListener('click',async()=>{
  connect.disabled=true;
  try {
    // The first loopback request must happen on a user gesture so that
    // browsers can show their local-network permission prompt.
    const state=await client.status();
    if(state.connected) await updateStatus(state);
    else await client.pair();
  } catch(error) {showError(error);}
  finally {connect.disabled=false;}
});
disconnect.addEventListener('click',async()=>{
  let confirmed=false;
  try {await client.disconnect();confirmed=true;} catch { /* Do not claim the bridge revoked the session. */ }
  setReady(false);result.hidden=true;output.textContent='';
  status.textContent=confirmed?'Disconnected.':'Could not confirm disconnection. Restart the local bridge to end outstanding sessions.';
});
form.addEventListener('submit',async event=>{
  event.preventDefault();const text=input.value.trim();if(!ready||busy||!text)return;
  busy=true;setReady(true);result.hidden=true;status.textContent='Creating a summary…';
  try {
    const response=await client.generate({provider:provider.value,input:`Summarize the following text clearly and concisely, using its language:\n\n${text}`});
    output.textContent=response.output;result.hidden=false;status.textContent='Connected to your local bridge.';
  } catch(error) {showError(error);}
  finally {busy=false;setReady(ready);}
});
try {
  const pairing=await client.completePairing();
  if(pairing.paired) await updateStatus();
  else status.textContent='Choose Connect AI to check the local bridge and approve this website.';
} catch(error) {setReady(false);showError(error);}
