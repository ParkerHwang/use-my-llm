#!/usr/bin/env node
import { runClaudeAuthCommand, type ClaudeAuthMode } from './claude-auth.mjs';
import { createBridge } from './server.mjs';
import { createProviderRegistry } from './providers/index.mjs';
import { runContextCommand } from './context/cli.mjs';
import { createContextStore } from './context/store.mjs';

const help = `use-my-llm local bridge\n\nUsage: use-my-llm [--port PORT] [--allow-origin ORIGIN ...] [--claude-auth-mode subscription|api-key] [--enable-claude-api] [--enable-antigravity-api] [--unsafe-enable-antigravity-acp]\n       use-my-llm context <command>   Share local conversations and memory with a website you choose (see "use-my-llm context help")\n\nRun this on the same computer as the browser. Websites must be approved locally.\nOnly local configuration selects providers; websites cannot choose executables or paths.\nClaude API mode requires Anthropic API credentials and may incur API charges.\nAntigravity API mode requires the official Python SDK and a Gemini API key.\nClaude subscription mode uses the official Claude Code login and counts against your Claude plan limits.\nUse "use-my-llm claude-auth connect" to sign in; "claude-auth disconnect" disconnects the bridge login.\n--claude-auth-mode subscription|api-key overrides the saved local mode; --enable-claude-api remains an API-key alias.\n--unsafe-enable-antigravity-acp lets a website continue a frozen Antigravity transcript you shared through a new "agy acp" session.\n  The bridge cannot switch off or contain Antigravity's own tools in that mode. Read SECURITY.md first.\nlocalhost-agent is the same command.\n`;
interface CliConfig {
  port: number;
  allowedOrigins?: string[];
  enableClaudeApi: boolean;
  claudeAuthMode?: ClaudeAuthMode;
  enableAntigravityApi: boolean;
  unsafeAntigravityAcp: boolean;
}
function parse(argv: string[]): { help: true } | { help: false; config: CliConfig } {
  const config: CliConfig = { port: 43189, allowedOrigins: [], enableClaudeApi: false, enableAntigravityApi: false, unsafeAntigravityAcp: false };
  for (let i=0;i<argv.length;i++) {
    const value=argv[i];
    if (value==='--help' || value==='-h') return {help:true};
    if (value==='--port') {
      const raw=argv[++i]; if(!raw || !/^\d+$/.test(raw) || +raw<1024 || +raw>65535) throw new Error('Invalid port.');
      config.port=+raw;
    } else if (value==='--allow-origin') {
      const raw=argv[++i]; if(!raw || raw.startsWith('--')) throw new Error('Missing origin.');
      config.allowedOrigins!.push(raw);
    } else if (value==='--claude-auth-mode') {
      const mode=argv[++i];
      if (mode !== 'subscription' && mode !== 'api-key') throw new Error('Invalid Claude auth mode.');
      config.claudeAuthMode=mode;
    } else if (value==='--enable-claude-api') config.enableClaudeApi=true;
    else if (value==='--enable-antigravity-api') config.enableAntigravityApi=true;
    else if (value==='--unsafe-enable-antigravity-acp') config.unsafeAntigravityAcp=true;
    else throw new Error('Unknown argument.');
  }
  if (!config.allowedOrigins!.length) delete config.allowedOrigins;
  return {help:false,config};
}
if (process.argv[2] === 'claude-auth') {
  try { process.exitCode = await runClaudeAuthCommand(process.argv.slice(3)); }
  catch { process.stderr.write('Unable to configure Claude authentication.\n'); process.exitCode=1; }
} else if (process.argv[2] === 'context') {
  // Local-only management of shared context. It never starts a listener.
  process.exitCode = await runContextCommand(process.argv.slice(3));
} else try {
  const parsed=parse(process.argv.slice(2));
  if(parsed.help) { process.stdout.write(help); }
  else {
    const {unsafeAntigravityAcp,...config}=parsed.config;
    if (unsafeAntigravityAcp) {
      process.stderr.write('WARNING: --unsafe-enable-antigravity-acp is on. A website can continue a frozen Antigravity transcript you shared, and the bridge cannot switch off or contain the tools Antigravity runs itself. Share Antigravity conversations only with websites you fully trust.\n');
    }
    const registry=createProviderRegistry({enableClaudeApi:config.enableClaudeApi,claudeAuthMode:config.claudeAuthMode,enableAntigravityApi:config.enableAntigravityApi,unsafeAntigravityAcp});
    // Sharing is off for every website until the user grants something locally.
    const bridge=createBridge({...config,runProvider:registry.runProvider,getProviders:registry.getProviders,context:createContextStore()});
    const address=await bridge.listen();
    process.stdout.write(`LOCALHOST_AGENT_READY http://127.0.0.1:${address.port}\n`);
    let closing=false;
    const shutdown=async()=>{
      if(closing)return;
      closing=true;
      // Bound the entire shutdown so the parent launcher's four-second grace
      // period leaves time for the process to exit after provider cleanup.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 3_500); });
      try { await Promise.race([bridge.close(), deadline]); }
      finally { clearTimeout(timer); process.exit(0); }
    };
    process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
  }
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code==='EADDRINUSE') process.stderr.write('The local bridge port is already in use. Stop the other bridge or choose another port.\n');
  else process.stderr.write('Unable to start the local bridge. Check local configuration and try again.\n');
  process.exitCode=1;
}
