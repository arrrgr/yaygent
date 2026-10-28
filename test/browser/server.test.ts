import { describe, expect, it } from 'vitest';
import { buildApp, requestPathname } from '../../src/server.js';
import type { Config } from '../../src/config.js';

const base: Config = {
  apiKeys: ['right-key'],
  openrouterApiKey: '',
  serperApiKey: 'serper-key',
  port: 3000,
  logLevel: 'silent',
  browserPoolSize: 0,
  workerConcurrency: 1,
  llmProvider: 'claude_code',
  codeVersion: 'test',
};

function app(overrides: Partial<Config> = {}) {
  return buildApp({ ...base, ...overrides });
}

describe('requestPathname', () => {
  it('drops the query string, the fragment and trailing slashes', () => {
    expect(requestPathname('/health')).toBe('/health');
    expect(requestPathname('/health/')).toBe('/health');
    expect(requestPathname('/health?x=1')).toBe('/health');
    expect(requestPathname('/health/?x=1#f')).toBe('/health');
    expect(requestPathname('/')).toBe('/');
    expect(requestPathname('/v1/run/batch')).toBe('/v1/run/batch');
  });
});

describe('auth', () => {
  it('exempts /health by pathname, not by exact string', async () => {
    const server = app();
    // an exact-string match made this a 401
    const res = await server.inject({ method: 'GET', url: '/health?probe=1' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('still rejects an unauthenticated or wrong-key request', async () => {
    const server = app();
    expect((await server.inject({ method: 'GET', url: '/v1/templates' })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: 'GET', url: '/v1/templates', headers: { 'x-api-key': 'wrong' } })).statusCode
    ).toBe(401);
    // a wrong key of a different LENGTH must fail the same way, not throw
    expect(
      (await server.inject({ method: 'GET', url: '/v1/templates', headers: { 'x-api-key': 'w' } })).statusCode
    ).toBe(401);
    expect(
      (await server.inject({ method: 'GET', url: '/v1/templates', headers: { 'x-api-key': 'right-key' } })).statusCode
    ).toBe(200);
    await server.close();
  });
});

describe('/health readiness', () => {
  it('reports search, provider, database and pool readiness', async () => {
    const server = app({ databaseUrl: 'postgres://x' });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.search).toEqual({ backend: 'serper', key_present: true });
    expect(body.llm).toEqual({ provider: 'claude_code', ready: true });
    expect(body.database).toEqual({ configured: true });
    expect(body.browser_pool.configured).toBeDefined();
    await server.close();
  });

  it('is degraded, not ok, when the search key is missing', async () => {
    const server = app({ serperApiKey: '' });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().ready).toBe(false);
    await server.close();
  });

  it('fails the healthcheck when the selected LLM provider has no key', async () => {
    const server = app({ llmProvider: 'anthropic', anthropicApiKey: undefined });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().llm).toEqual({ provider: 'anthropic', ready: false });
    await server.close();
  });
});
