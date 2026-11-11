import { findCodex, runCodex } from './codex.mjs';
import { claudeApiConfigured, runClaudeApi } from './claude-api.mjs';
import { googleApiConfigured, googleSdkAvailable, runGoogleSdk } from './google-sdk.mjs';
import type { ProviderRequest, ProviderReply, ProviderStatus } from '../server.mjs';

export interface ProviderRegistryOptions {
  enableClaudeApi?: boolean;
  enableAntigravityApi?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Local process configuration, never selected by the requesting website. */
export function createProviderRegistry({enableClaudeApi = false, enableAntigravityApi = false, env = process.env}: ProviderRegistryOptions = {}) {
  // Probe the optional local SDK only after an explicit API-mode opt-in.
  const googleReady = Boolean(enableAntigravityApi && googleApiConfigured(env) && googleSdkAvailable());
  function availability(): ProviderStatus[] {
    return [
      {id:'codex', available:Boolean(findCodex())},
      // Explicit API mode only. Do not assume a locally signed-in consumer
      // subscription is licensed for an unrelated website to intermediate.
      {id:'claude', available:Boolean(enableClaudeApi && claudeApiConfigured(env))},
      // This is the official SDK's API-key route, not the desktop subscription.
      // The separate ACP/subscription route remains unavailable.
      {id:'antigravity', available:googleReady}
    ];
  }
  async function runProvider({provider,message,history,signal}: ProviderRequest): Promise<ProviderReply> {
    const status=availability().find(item=>item.id===provider);
    if(!status?.available) {
      throw Object.assign(new Error('Provider is unavailable or not enabled in local configuration.'), {code:'PROVIDER_UNAVAILABLE'});
    }
    if(provider==='codex') return runCodex({message,history,signal});
    if(provider==='claude') return runClaudeApi({message,history,signal,env});
    if(provider==='antigravity') return runGoogleSdk({message,history,signal,env});
    throw Object.assign(new Error('Provider unavailable.'), {code:'PROVIDER_UNAVAILABLE'});
  }
  return {getProviders:availability,runProvider};
}
