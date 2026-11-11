import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyAcpAvailable, findAgy, runAntigravityAcp, spawnAgyAcp } from './antigravity.mjs';
import { findClaude, forkClaude } from './claude.mjs';
import { findCodex, forkCodex, runCodex } from './codex.mjs';
import { claudeApiConfigured, runClaudeApi } from './claude-api.mjs';
import { googleApiConfigured, googleSdkAvailable, runGoogleSdk } from './google-sdk.mjs';
import { CONTEXT_NOTICE, promptData } from './prompt.mjs';
import type { ProviderRequest, ProviderReply, ProviderStatus } from '../server.mjs';

export interface ProviderRegistryOptions {
  enableClaudeApi?: boolean;
  enableAntigravityApi?: boolean;
  /**
   * Local opt-in for continuing Antigravity conversations through `agy acp`.
   * The agent's own tools are not contained by the bridge. See SECURITY.md.
   */
  unsafeAntigravityAcp?: boolean;
  env?: NodeJS.ProcessEnv;
}

function unavailable(code = 'PROVIDER_UNAVAILABLE') {
  return Object.assign(new Error('Provider is unavailable or not enabled in local configuration.'), { code });
}

/** Local process configuration, never selected by the requesting website. */
export function createProviderRegistry({
  enableClaudeApi = false, enableAntigravityApi = false, unsafeAntigravityAcp = false, env = process.env,
}: ProviderRegistryOptions = {}) {
  // Probe the optional local SDK only after an explicit API-mode opt-in.
  const googleReady = Boolean(enableAntigravityApi && googleApiConfigured(env) && googleSdkAvailable());
  const acpReady = Boolean(unsafeAntigravityAcp && agyAcpAvailable());
  function availability(): ProviderStatus[] {
    return [
      {id:'codex', available:Boolean(findCodex())},
      // Explicit API mode only. Do not assume a locally signed-in consumer
      // subscription is licensed for an unrelated website to intermediate.
      {id:'claude', available:Boolean(enableClaudeApi && claudeApiConfigured(env))},
      // The official SDK's API-key route, or the explicitly enabled ACP route
      // that only continues conversations the user shared.
      {id:'antigravity', available:googleReady || acpReady}
    ];
  }

  async function continueWithAcp(request: ProviderRequest, sessionId: string): Promise<ProviderReply> {
    const executable = findAgy();
    if (!acpReady || !executable) throw unavailable('CONTEXT_UNAVAILABLE');
    const workspace = await mkdtemp(join(tmpdir(), 'use-my-llm-agy-'));
    try {
      const context = request.context ?? [];
      const text = 'Continue this conversation as text only. Do not use tools, read or write files, run commands, or browse. ' +
        (context.length ? `${CONTEXT_NOTICE} ` : '') +
        'The current user message follows as JSON data.\n\n' + promptData(context, undefined, request.message);
      return await runAntigravityAcp({
        transport: spawnAgyAcp(executable, workspace),
        cwd: workspace,
        text,
        signal: request.signal,
        sessionId,
        // Only reached behind the explicit opt-in, whose warning covers in-place continuation.
        allowInPlace: true,
        failOnToolActivity: true,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function runProvider(request: ProviderRequest): Promise<ProviderReply> {
    const {provider,message,history,context,fork,signal} = request;
    const status=availability().find(item=>item.id===provider);
    if(!status?.available) throw unavailable();
    if (fork) {
      // The bridge already checked this. A copy never crosses to another provider.
      if (fork.provider !== provider) throw unavailable('CONTEXT_UNAVAILABLE');
      if (fork.provider === 'codex') return forkCodex({fork,message,context,signal});
      if (fork.provider === 'claude') {
        // Anthropic API key mode only. A subscription login is never used to continue.
        if (!findClaude()) throw unavailable('CONTEXT_UNAVAILABLE');
        return forkClaude({fork,message,context,signal,env});
      }
      return continueWithAcp(request, fork.sessionId);
    }
    if(provider==='codex') return runCodex({message,history,context,signal});
    if(provider==='claude') return runClaudeApi({message,history,context,signal,env});
    if(provider==='antigravity') {
      // Without a shared conversation to continue, only the API-key route answers.
      if (!googleReady) throw unavailable();
      return runGoogleSdk({message,history,context,signal,env});
    }
    throw unavailable();
  }
  return {getProviders:availability,runProvider};
}
