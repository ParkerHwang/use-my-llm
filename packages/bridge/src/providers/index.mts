import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyAcpAvailable, findAgy, MAX_ACP_PROMPT_BYTES, runAntigravityAcp, spawnAgyAcp } from './antigravity.mjs';
import { findClaude, forkClaude, runClaude } from './claude.mjs';
import { findCodex, forkCodex, runCodex } from './codex.mjs';
import { claudeApiConfigured, runClaudeApi } from './claude-api.mjs';
import { googleApiConfigured, googleSdkAvailable, runGoogleSdk } from './google-sdk.mjs';
import { CONTEXT_NOTICE, promptData } from './prompt.mjs';
import { probeClaudeSubscription, claudeSubscriptionDirectory, readClaudeAuthMode, type ClaudeAuthMode } from '../claude-auth.mjs';
import type { ProviderRequest, ProviderReply, ProviderStatus } from '../server.mjs';

export interface ProviderRegistryOptions {
  enableClaudeApi?: boolean;
  claudeAuthMode?: ClaudeAuthMode;
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
  enableClaudeApi = false, claudeAuthMode, enableAntigravityApi = false, unsafeAntigravityAcp = false, env = process.env,
}: ProviderRegistryOptions = {}) {
  // Probe the optional local SDK only after an explicit API-mode opt-in.
  const googleReady = Boolean(enableAntigravityApi && googleApiConfigured(env) && googleSdkAvailable());
  const acpReady = Boolean(unsafeAntigravityAcp && agyAcpAvailable());
  // Explicit launch flags take precedence over persisted menu/CLI settings.
  const mode = () => claudeAuthMode ?? (enableClaudeApi ? 'api-key' : readClaudeAuthMode(env));
  let checkedAt = 0;
  let connected = false;
  let probing: Promise<boolean> | undefined;
  function subscriptionReady(): Promise<boolean> {
    if (probing) return probing;
    if (Date.now() - checkedAt <= 5_000) return Promise.resolve(connected);
    probing = probeClaudeSubscription(env).then(value => {
      connected = value;
      checkedAt = Date.now();
      return value;
    }).finally(() => { probing = undefined; });
    return probing;
  }
  function availability(): ProviderStatus[] {
    // Refresh asynchronously; status and unrelated providers never wait on Keychain.
    if (mode() === 'subscription') void subscriptionReady();
    return [
      {id:'codex', available:Boolean(findCodex())},
      {id:'claude', available:mode() === 'subscription' ? connected : Boolean(mode() === 'api-key' && claudeApiConfigured(env)),
        ...(mode() && { authMode: mode()! })},
      // The official SDK's API-key route, or the explicitly enabled ACP route
      // that only continues conversations the user shared.
      {id:'antigravity', available:googleReady, ...(acpReady && { continuationAvailable: true as const })}
    ];
  }

  async function continueWithAcp(request: ProviderRequest): Promise<ProviderReply> {
    const executable = findAgy();
    if (!acpReady || !executable || !request.forkTranscript?.trim()) throw unavailable('CONTEXT_UNAVAILABLE');
    const context = [...(request.context ?? []), { source: 'antigravity:fork', text: request.forkTranscript }];
    const text = 'Continue this conversation as text only. Do not use tools, read or write files, run commands, or browse. ' +
      `${CONTEXT_NOTICE} ` +
      'The current user message follows as JSON data.\n\n' + promptData(context, undefined, request.message);
    if (Buffer.byteLength(text) > MAX_ACP_PROMPT_BYTES) throw unavailable('CONTEXT_TOO_LARGE');
    const workspace = await mkdtemp(join(tmpdir(), 'use-my-llm-agy-'));
    try {
      request.signal?.throwIfAborted();
      const transport = spawnAgyAcp(executable, workspace);
      try {
        return await runAntigravityAcp({ transport, cwd: workspace, text, signal: request.signal, failOnToolActivity: true });
      } finally {
        transport.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function runProvider(request: ProviderRequest): Promise<ProviderReply> {
    const {provider,message,history,context,fork,forkTranscript,signal} = request;
    if (provider === 'claude' && mode() === 'subscription') await subscriptionReady();
    signal?.throwIfAborted();
    const status=availability().find(item=>item.id===provider);
    if (!(status?.available || (fork && status?.continuationAvailable))) throw unavailable();
    if (fork) {
      // The bridge already checked this. A copy never crosses to another provider.
      if (fork.provider !== provider) throw unavailable('CONTEXT_UNAVAILABLE');
      if (fork.provider === 'codex') return forkCodex({fork,transcript:forkTranscript,message,context,signal});
      if (fork.provider === 'claude') {
        if (!findClaude()) throw unavailable('CONTEXT_UNAVAILABLE');
        return forkClaude({fork,message,context,signal,env,authMode:status.authMode ?? 'api-key',subscriptionConfigDir:claudeSubscriptionDirectory(env)});
      }
      return continueWithAcp(request);
    }
    if(provider==='codex') return runCodex({message,history,context,signal});
    if(provider==='claude') return status.authMode === 'subscription'
      ? runClaude({message,history,context,signal,env,authMode:'subscription',subscriptionConfigDir:claudeSubscriptionDirectory(env)})
      : runClaudeApi({message,history,context,signal,env});
    if(provider==='antigravity') {
      // Without a shared conversation to continue, only the API-key route answers.
      if (!googleReady) throw unavailable();
      return runGoogleSdk({message,history,context,signal,env});
    }
    throw unavailable();
  }
  return {getProviders:availability,runProvider};
}
