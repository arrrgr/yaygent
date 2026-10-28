import 'dotenv/config';

export interface Config {
  apiKeys: string[];
  openrouterApiKey: string;
  serperApiKey: string;
  port: number;
  logLevel: string;
  browserPoolSize: number;
  workerConcurrency: number;
  llmProvider: 'openrouter' | 'anthropic' | 'claude_code';
  anthropicApiKey?: string;
  databaseUrl?: string;
  codeVersion: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export function loadConfig(): Config {
  const rawApiKey = requireEnv('YAYGENT_API_KEY');
  const apiKeys = rawApiKey
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (apiKeys.length === 0) {
    throw new Error('YAYGENT_API_KEY must contain at least one non-empty key');
  }

  const providerStr = optionalEnv('LLM_PROVIDER', 'openrouter');
  if (providerStr !== 'openrouter' && providerStr !== 'anthropic' && providerStr !== 'claude_code') {
    throw new Error(`Invalid LLM_PROVIDER value: ${providerStr} (expected openrouter|anthropic|claude_code)`);
  }
  const llmProvider = providerStr;

  // Only the SELECTED provider's key is required. The service used to refuse to boot
  // without an OpenRouter key it would never use.
  const openrouterApiKey =
    llmProvider === 'openrouter' ? requireEnv('OPENROUTER_API_KEY') : optionalEnv('OPENROUTER_API_KEY', '');

  // Serper is the only working search backend; without it every search degrades to a
  // Bing parser over a proxy. Warn loudly rather than failing a boot that can still serve.
  const serperApiKey = optionalEnv('SERPER_API_KEY', '').trim();
  if (!serperApiKey) {
    console.warn('[config] SERPER_API_KEY is NOT set - search will fall back to Google News RSS / Bing over the proxy and will mostly return nothing');
  }

  const portStr = optionalEnv('PORT', '3000');
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${portStr}`);
  }

  const logLevel = optionalEnv('LOG_LEVEL', 'info');

  const poolSizeStr = optionalEnv('BROWSER_POOL_SIZE', '3');
  const browserPoolSize = parseInt(poolSizeStr, 10);
  if (isNaN(browserPoolSize) || browserPoolSize < 0) {
    throw new Error(`Invalid BROWSER_POOL_SIZE value: ${poolSizeStr}`);
  }

  const concurrencyStr = optionalEnv('WORKER_CONCURRENCY', '40');
  const workerConcurrency = parseInt(concurrencyStr, 10);
  if (isNaN(workerConcurrency) || workerConcurrency < 1) {
    throw new Error(`Invalid WORKER_CONCURRENCY value: ${concurrencyStr}`);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'] || undefined;
  if (llmProvider === 'anthropic' && !anthropicApiKey) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  const databaseUrl = process.env['YAYGENT_DATABASE_URL'] || undefined;
  const codeVersion =
    process.env['CODE_VERSION'] || process.env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 8) || 'dev';

  return {
    apiKeys,
    openrouterApiKey,
    serperApiKey,
    port,
    logLevel,
    browserPoolSize,
    workerConcurrency,
    llmProvider,
    anthropicApiKey,
    databaseUrl,
    codeVersion,
  };
}
