import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { runRoutes, type Runners } from '../../src/routes/run.js';
import type { Config } from '../../src/config.js';
import type { BrowserPool } from '../../src/browser/pool.js';
import { baseDeps, scriptedExtractor } from './helpers.js';

const config: Config = {
  apiKeys: ['k'],
  openrouterApiKey: 'or',
  port: 0,
  logLevel: 'silent',
  browserPoolSize: 0,
  workerConcurrency: 2,
  searxngUrl: '',
  llmProvider: 'openrouter',
  codeVersion: 'test',
};

const calls: { react: unknown[]; cycle: unknown[] } = { react: [], cycle: [] };

const runners: Runners = {
  react: async (opts) => {
    calls.react.push(opts);
    return { result: '[{"full_name":"React Person"}]', steps: [], turns: 1, status: 'completed', cost_usd: 0.0001, model: opts.model };
  },
  cycle: async (tmpl, inputs, deps, opts) => {
    calls.cycle.push({ name: tmpl.name, inputs, cycles: opts?.cycles, model: deps.extractor.model });
    return {
      status: 'completed',
      data: { founders: [{ full_name: 'Cycle Person', linkedin_url: null, title: null, country_of_origin: null }] },
      _meta: { cycles: 1, locked: {}, candidates: {}, cast_failures: [], cache: { result_hit: false, page_hits: 0 }, cost_usd: 0.001 } as never,
      steps: [{ type: 'search', query: 'q', cycle: 0 }],
      turns: 1,
      cost_usd: 0.001,
      elapsed_ms: 5,
      model: deps.extractor.model,
    };
  },
  extractorFor: (_config, requested, templateModel) => ({ ...scriptedExtractor(() => ({})), model: requested ?? templateModel ?? 'default' }),
  buildDeps: (_config, extractor) => baseDeps(extractor),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(runRoutes, { prefix: '/v1', browserPool: {} as BrowserPool, config, runners });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function run(body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/v1/run', payload: body });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('POST /v1/run mode routing', () => {
  it('defaults to cycle for a v2 template and returns result string + data + _meta', async () => {
    calls.cycle.length = 0;
    const { status, body } = await run({ template: 'find_founders', inputs: { company_name: 'Acme', domain: 'acme.com' } });
    expect(status).toBe(200);
    expect(calls.cycle.length).toBe(1);
    expect(typeof body['result']).toBe('string');
    expect(JSON.parse(body['result'] as string)).toEqual(body['data']);
    expect((body['data'] as Record<string, unknown[]>)['founders'][0]).toMatchObject({ full_name: 'Cycle Person' });
    expect(body['_meta']).toBeTruthy();
    expect(body['template']).toBe('find_founders');
    expect(body['turns']).toBe(1);
    expect(body['status']).toBe('completed');
  });

  it('maps max_turns to cycles and model to the extractor model', async () => {
    calls.cycle.length = 0;
    const { status, body } = await run({ template: 'find_founders', inputs: { company_name: 'Acme', domain: 'acme.com' }, max_turns: 2, model: 'claude-haiku-4-5' });
    expect(status).toBe(200);
    expect(calls.cycle[0]).toMatchObject({ cycles: 2, model: 'claude-haiku-4-5' });
    expect(body['model']).toBe('claude-haiku-4-5');
  });

  it('rejects prompt_extension on v2 with 400', async () => {
    const { status, body } = await run({ template: 'find_founders', inputs: { company_name: 'Acme', domain: 'acme.com' }, prompt_extension: 'also do x' });
    expect(status).toBe(400);
    expect(String(body['error'])).toMatch(/prompt_extension/);
  });

  it('rejects missing required v2 inputs with 400 but allows optional ones to be absent', async () => {
    const missing = await run({ template: 'find_founders', inputs: { company_name: 'Acme' } });
    expect(missing.status).toBe(400);
    expect(String(missing.body['error'])).toMatch(/domain/);
  });

  it('mode: react on a v2 name uses the templates/v1 copy and the react loop', async () => {
    calls.react.length = 0;
    const { status, body } = await run({
      template: 'find_founders',
      mode: 'react',
      inputs: { company_name: 'Acme', domain: 'acme.com', company_linkedin_url: '', industry: '', description: '', founded: '', locality: '', slug: '' },
    });
    expect(status).toBe(200);
    expect(calls.react.length).toBe(1);
    expect(body['data']).toBeUndefined();
    // the v1 find_founders sanitizer still runs on react output
    expect(JSON.parse(body['result'] as string)).toEqual([{ full_name: 'React Person', first_name: '', last_name: '', country_of_origin: '', linkedin_url: '' }]);
  });

  it('inline prompt defaults to react and refuses mode: cycle', async () => {
    calls.react.length = 0;
    const ok = await run({ prompt: 'Who is the CEO of Stripe?' });
    expect(ok.status).toBe(200);
    expect(calls.react.length).toBe(1);
    const bad = await run({ prompt: 'x', mode: 'cycle' });
    expect(bad.status).toBe(400);
  });

  it('unknown template is 404, bad mode is 400', async () => {
    expect((await run({ template: 'nope', inputs: {} })).status).toBe(404);
    expect((await run({ template: 'find_founders', inputs: { company_name: 'A', domain: 'a.com' }, mode: 'weird' })).status).toBe(400);
  });

  it('batch rows carry data + _meta for v2 and honour mode', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/run/batch',
      payload: { template: 'find_founders', rows: [{ company_name: 'A', domain: 'a.com' }, { company_name: 'B' }] },
    });
    expect(start.statusCode).toBe(202);
    const jobId = (start.json() as { job_id: string }).job_id;
    let poll: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const r = await app.inject({ method: 'GET', url: `/v1/run/batch/${jobId}` });
      poll = r.json() as Record<string, unknown>;
      if (poll['status'] === 'completed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(poll['status']).toBe('completed');
    const results = poll['results'] as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    expect(results[0]['data']).toBeTruthy();
    expect(results[0]['_meta']).toBeTruthy();
    expect(typeof results[0]['result']).toBe('string');
    // the row missing `domain` fails validation once (4xx is not retried) and is reported as an error row
    expect(results[1]['status']).toBe('error');
    expect(String(results[1]['result'])).toMatch(/domain/);
    expect(poll['failed']).toBe(1);
  });
});

import { cycleTimeoutMs } from '../../src/routes/run.js';

describe('cycle route timeout', () => {
  it('always sits above the template wall budget', () => {
    expect(cycleTimeoutMs(30_000)).toBe(180_000);
    expect(cycleTimeoutMs(150_000)).toBe(240_000);
    expect(cycleTimeoutMs(600_000)).toBe(690_000);
  });
});
