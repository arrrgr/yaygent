/**
 * Batch-runner regressions: REVIEW_v2_engine.md 2.10 and 2.11.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { recordRow, runRoutes, type Job, type Runners } from '../../src/routes/run.js';
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

function emptyJob(total: number): Job {
  return {
    id: 'j',
    status: 'running',
    total,
    completed_count: 0,
    failed_count: 0,
    total_cost_usd: 0,
    results: [],
    recorded: new Set<number>(),
    started_at: 0,
    expires_at: 0,
  };
}

const row = (row_index: number, status: string, cost = 0) => ({
  status,
  result: status,
  steps: [],
  turns: 0,
  cost_usd: cost,
  elapsed_ms: 0,
  model: 'm',
  row_index,
  inputs: {},
});

describe('2.10 one result per row_index, ever', () => {
  it('refuses a second result for a row the timeout already failed', () => {
    const job = emptyJob(2);
    // the 15-minute cap fails every unfinished row...
    expect(recordRow(job, row(0, 'error'), true)).toBe(true);
    expect(recordRow(job, row(1, 'error'), true)).toBe(true);
    // ...then an in-flight row finishes anyway. queue.clear() never cancelled it.
    expect(recordRow(job, row(0, 'completed', 0.01), false)).toBe(false);

    expect(job.results.length).toBe(2);
    expect(job.results.filter((r) => r.row_index === 0).length).toBe(1);
    expect(job.completed_count + job.failed_count).toBe(job.total);
    expect(job.total_cost_usd).toBe(0);
  });

  it('counts cost only for rows it actually recorded', () => {
    const job = emptyJob(2);
    expect(recordRow(job, row(0, 'completed', 0.25), false)).toBe(true);
    expect(recordRow(job, row(0, 'completed', 0.25), false)).toBe(false);
    expect(job.total_cost_usd).toBe(0.25);
    expect(job.completed_count).toBe(1);
  });
});

describe('2.11 a row that hit the route timeout is not retried', () => {
  let app: FastifyInstance;
  let cycleCalls = 0;

  const runners: Runners = {
    react: async (opts) => ({ result: 'x', steps: [], turns: 1, status: 'completed', cost_usd: 0, model: opts.model }),
    cycle: async () => {
      cycleCalls++;
      throw Object.assign(new Error('Agent run timed out after 240 seconds'), { statusCode: 504 });
    },
    extractorFor: () => ({ ...scriptedExtractor(() => ({})), model: 'm' }),
    buildDeps: (_config, extractor) => baseDeps(extractor),
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(runRoutes, { prefix: '/v1', browserPool: {} as BrowserPool, config, runners });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the row once, not twice on top of a cycle that is still running', async () => {
    cycleCalls = 0;
    const start = await app.inject({
      method: 'POST',
      url: '/v1/run/batch',
      payload: { template: 'find_founders', rows: [{ company_name: 'A', domain: 'a.com' }] },
    });
    const jobId = (start.json() as { job_id: string }).job_id;

    let poll: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) {
      const r = await app.inject({ method: 'GET', url: `/v1/run/batch/${jobId}` });
      poll = r.json() as Record<string, unknown>;
      if (poll['status'] === 'completed') break;
      await new Promise((res) => setTimeout(res, 10));
    }

    expect(poll['status']).toBe('completed');
    // BATCH_ROW_ATTEMPTS is 2 and a 504 is a 5xx, so this used to be 2
    expect(cycleCalls).toBe(1);
    expect(poll['failed']).toBe(1);
    const results = poll['results'] as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);
    expect(String(results[0]!['result'])).toMatch(/timed out/);
  });
});
