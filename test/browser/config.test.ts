import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';

const KEYS = [
  'YAYGENT_API_KEY',
  'OPENROUTER_API_KEY',
  'SERPER_API_KEY',
  'LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'SEARXNG_URL',
  'YAYGENT_DATABASE_URL',
  'CODE_VERSION',
  'BROWSER_POOL_SIZE',
  'WORKER_CONCURRENCY',
  'PORT',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env['YAYGENT_API_KEY'] = 'k';
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('loadConfig', () => {
  it('does not require OPENROUTER_API_KEY when another provider is selected', () => {
    process.env['LLM_PROVIDER'] = 'claude_code';
    expect(() => loadConfig()).not.toThrow();

    process.env['LLM_PROVIDER'] = 'anthropic';
    process.env['ANTHROPIC_API_KEY'] = 'a';
    expect(loadConfig().openrouterApiKey).toBe('');
  });

  it('still requires OPENROUTER_API_KEY when that provider IS selected', () => {
    process.env['LLM_PROVIDER'] = 'openrouter';
    expect(() => loadConfig()).toThrow(/OPENROUTER_API_KEY/);
    process.env['OPENROUTER_API_KEY'] = 'or';
    expect(loadConfig().openrouterApiKey).toBe('or');
  });

  it('warns loudly when SERPER_API_KEY is missing but still boots', () => {
    process.env['LLM_PROVIDER'] = 'claude_code';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig();
    expect(config.serperApiKey).toBe('');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SERPER_API_KEY'))).toBe(true);
    warn.mockRestore();
  });

  it('carries the serper key through when set', () => {
    process.env['LLM_PROVIDER'] = 'claude_code';
    process.env['SERPER_API_KEY'] = '  serper  ';
    expect(loadConfig().serperApiKey).toBe('serper');
  });

  it('no longer exposes the dead searxngUrl setting', () => {
    process.env['LLM_PROVIDER'] = 'claude_code';
    process.env['SEARXNG_URL'] = 'http://searxng.railway.internal:8080';
    expect(loadConfig()).not.toHaveProperty('searxngUrl');
  });

  it('rejects an unknown provider', () => {
    process.env['LLM_PROVIDER'] = 'gpt';
    expect(() => loadConfig()).toThrow(/Invalid LLM_PROVIDER/);
  });
});
