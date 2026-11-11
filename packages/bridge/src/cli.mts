#!/usr/bin/env node
import { createBridge } from './server.mjs';
import { createProviderRegistry } from './providers/index.mjs';

const help = `LocalHostAgent SDK local bridge\n\nUsage: localhost-agent [--port PORT] [--allow-origin ORIGIN ...] [--enable-claude-api] [--enable-antigravity-api]\n\nRun this on the same computer as the browser. Websites must be approved locally.\nOnly local configuration selects providers; websites cannot choose executables or paths.\nClaude API mode requires Anthropic API credentials and may incur API charges.\nAntigravity API mode requires the official Python SDK and a Gemini API key.\nConsumer subscription reuse through third-party websites is not enabled.\n`;
interface CliConfig {
  port: number;
  allowedOrigins?: string[];
  enableClaudeApi: boolean;
  enableAntigravityApi: boolean;
}
function parse(argv: string[]): { help: true } | { help: false; config: CliConfig } {
  const config: CliConfig = { port: 43189, allowedOrigins: [], enableClaudeApi: false, enableAntigravityApi: false };
  for (let i=0;i<argv.length;i++) {
    const value=argv[i];
    if (value==='--help' || value==='-h') return {help:true};
    if (value==='--port') {
      const raw=argv[++i]; if(!raw || !/^\d+$/.test(raw) || +raw<1024 || +raw>65535) throw new Error('Invalid port.');
      config.port=+raw;
    } else if (value==='--allow-origin') {
      const raw=argv[++i]; if(!raw || raw.startsWith('--')) throw new Error('Missing origin.');
      config.allowedOrigins!.push(raw);
    } else if (value==='--enable-claude-api') config.enableClaudeApi=true;
    else if (value==='--enable-antigravity-api') config.enableAntigravityApi=true;
    else throw new Error('Unknown argument.');
  }
  if (!config.allowedOrigins!.length) delete config.allowedOrigins;
  return {help:false,config};
}
try {
  const parsed=parse(process.argv.slice(2));
  if(parsed.help) { process.stdout.write(help); }
  else {
    const config=parsed.config;
    const registry=createProviderRegistry({enableClaudeApi:config.enableClaudeApi,enableAntigravityApi:config.enableAntigravityApi});
    const bridge=createBridge({...config,runProvider:registry.runProvider,getProviders:registry.getProviders});
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
