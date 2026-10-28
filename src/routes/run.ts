import { type FastifyInstance, type FastifyRequest, type FastifyReply, type FastifyPluginOptions } from 'fastify';
import PQueue from 'p-queue';
import { randomUUID } from 'crypto';
import { type BrowserPool } from '../browser/pool.js';
import { type Config } from '../config.js';
import { getTemplate, getTemplateAny } from '../templates/store.js';
import { type TemplateV2 } from '../templates/v2.js';
import { validateInputs, resolvePrompt } from '../templates/resolver.js';
import { runAgent, type AgentStep } from '../agent/index.js';
import { runCycle, type CycleDeps, type CycleMeta } from '../agent/cycle.js';
import { buildCycleDeps, extractorFor } from '../agent/deps.js';
import { type Extractor } from '../llm/index.js';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_SYSTEM_PROMPT =
  'You are a company research agent. Search the web and visit pages to find information. Be thorough and accurate.';
const RUN_TIMEOUT_MS = 180_000;
const MAX_BATCH_ROWS = 500;
const JOB_TTL_MS = 3_600_000; // 1 hour - clean up completed jobs
const BATCH_JOB_TIMEOUT_MS = 900_000; // 15 min hard cap - mark remaining rows as error and complete
const BATCH_ROW_ATTEMPTS = 2;
const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export type RunMode = 'react' | 'cycle';

interface RunRequest {
  template?: string;
  prompt?: string;
  system_prompt?: string;
  inputs?: Record<string, string>;
  prompt_extension?: string;
  model?: string;
  max_turns?: number;
  /** default: cycle for version 2 templates, react for v1 and inline prompt */
  mode?: RunMode;
}

export interface RunResponse {
  status: string;
  /** v1: the agent's final text; v2: JSON.stringify(data) */
  result: string;
  steps: AgentStep[];
  turns: number;
  cost_usd: number;
  elapsed_ms: number;
  model: string;
  template?: string;
  /** v2 only */
  data?: Record<string, unknown>;
  _meta?: CycleMeta;
}

interface BatchRequest {
  template?: string;
  rows: Array<Record<string, string>>;
  prompt?: string;
  prompt_extension?: string;
  model?: string;
  max_turns?: number;
  mode?: RunMode;
}

/** Injectable runners so the route can be tested without the browser or an LLM. */
export interface Runners {
  react: typeof runAgent;
  cycle: typeof runCycle;
  extractorFor: (config: Config, requestedModel?: string, templateModel?: string) => Extractor;
  buildDeps: (config: Config, extractor: Extractor) => CycleDeps;
}

const DEFAULT_RUNNERS: Runners = { react: runAgent, cycle: runCycle, extractorFor, buildDeps: buildCycleDeps };

type RowResult = RunResponse & { row_index: number; inputs: Record<string, string> };

export interface Job {
  id: string;
  status: 'running' | 'completed';
  total: number;
  completed_count: number;
  failed_count: number;
  total_cost_usd: number;
  results: RowResult[];
  /** row_index values already in `results` - one result per row, ever */
  recorded: Set<number>;
  started_at: number;
  finished_at?: number;
  expires_at: number;
}

/**
 * Records a row's result exactly once. The 15-minute cap pushes an error row for
 * every row not yet finished, but `queue.clear()` does not cancel work already
 * in flight - so a late row pushed a SECOND entry for the same `row_index` and
 * the consumer polled a "completed" job with two answers for one row and
 * `completed + failed > total` (review 2.10).
 */
export function recordRow(job: Job, row: RowResult, failed: boolean): boolean {
  if (job.recorded.has(row.row_index)) return false;
  job.recorded.add(row.row_index);
  job.results.push(row);
  if (failed) job.failed_count++;
  else {
    job.completed_count++;
    job.total_cost_usd += row.cost_usd;
  }
  return true;
}

// In-memory job store - survives for JOB_TTL_MS after creation
const jobs = new Map<string, Job>();

function currentDateForPrompt(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function withRuntimeContext(systemPrompt: string): string {
  return `Current date: ${currentDateForPrompt()}. When the task asks for recent information, interpret dates relative to this date and do not treat old items as recent. Do not describe future scheduled events as already completed; label them as upcoming only if the requested schema allows it, otherwise use "n/a".\n\n${systemPrompt}`;
}

function parseNewsDates(value: string): Date[] {
  const dates: Date[] = [];
  const seen = new Set<string>();
  const addDate = (year: number, month: number, day: number) => {
    const date = new Date(Date.UTC(year, month, day));
    const key = date.toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(date);
    }
  };

  for (const match of value.matchAll(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:20)\d{2})\b/gi
  )) {
    addDate(Number(match[3]), MONTH_INDEX[match[1].toLowerCase()], Number(match[2]));
  }

  for (const match of value.matchAll(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+((?:20)\d{2})\b/gi
  )) {
    addDate(Number(match[2]), MONTH_INDEX[match[1].toLowerCase()], 1);
  }

  for (const match of value.matchAll(/\b((?:20)\d{2})\b/g)) {
    addDate(Number(match[1]), 0, 1);
  }

  return dates;
}

function isRecentNewsValue(value: unknown, cutoff: Date): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'n/a') return false;

  const dates = parseNewsDates(trimmed);
  if (dates.length === 0) return false;
  return dates.some((date) => date >= cutoff);
}

function sanitizeCompanyEnrichmentResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return result;

    const cutoff = subtractMonths(new Date(), 6);
    const validNews = [parsed['news_1'], parsed['news_2']].filter((value) =>
      isRecentNewsValue(value, cutoff)
    ) as string[];

    parsed['news_1'] = validNews[0] ?? 'n/a';
    parsed['news_2'] = validNews[1] ?? 'n/a';
    return JSON.stringify(parsed);
  } catch {
    return result;
  }
}

function sanitizeFindFoundersResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as unknown;
    const founders: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['founders'])
        ? ((parsed as Record<string, unknown>)['founders'] as unknown[])
        : [];

    const cleanValue = (value: unknown): string => {
      if (typeof value !== 'string') return '';
      const trimmed = value.trim();
      return /^(n\/a|na|unknown|not found|null|none)$/i.test(trimmed) ? '' : trimmed;
    };

    const cleaned = founders
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const firstName = cleanValue(item['first_name']);
        const lastName = cleanValue(item['last_name']);
        const fullName = cleanValue(item['full_name']) || [firstName, lastName].filter(Boolean).join(' ');
        return {
          full_name: fullName,
          first_name: firstName,
          last_name: lastName,
          country_of_origin: cleanValue(item['country_of_origin']),
          linkedin_url: cleanValue(item['linkedin_url']),
        };
      })
      .filter((item) => item.full_name || item.linkedin_url);

    return JSON.stringify(cleaned);
  } catch {
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prune expired jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expires_at < now) jobs.delete(id);
  }
}, 600_000);

interface RunRoutesOptions extends FastifyPluginOptions {
  browserPool: BrowserPool;
  config: Config;
  runners?: Runners;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Hard timeout around a run. The cycle enforces its own wall budget, but a scout call
 * (Apify profile scrape, a slow visit) can overshoot it, so the route timeout must sit
 * ABOVE the template wall or a nearly-complete row is thrown away as a 504.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number = RUN_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(httpError(`Agent run timed out after ${Math.round(timeoutMs / 1000)} seconds`, 504)),
      timeoutMs
    );
  });
  // The timer used to survive the winning path, so a fast run still held a
  // 240-second handle (review 2.11). The losing cycle cannot be cancelled from
  // here - it keeps burning Serper/Apify/LLM until its own wall budget ends it,
  // which is why the batch must not retry a 504 on top of it.
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Route timeout for a v2 template: its wall budget plus room for one overshooting scout call. */
export function cycleTimeoutMs(wallMs: number): number {
  return Math.max(RUN_TIMEOUT_MS, wallMs + 90_000);
}

/** v2 path: validate inputs, build the extractor + deps, run the cycle. */
async function executeCycle(
  tmpl: TemplateV2,
  body: RunRequest,
  config: Config,
  runners: Runners
): Promise<RunResponse> {
  const { inputs = {}, prompt_extension, model, max_turns } = body;

  if (prompt_extension) {
    throw httpError('prompt_extension is not supported on version 2 templates (use mode: "react" with a v1 template)', 400);
  }
  const missing = tmpl.required.filter((v) => !(v in inputs) || inputs[v] === '');
  if (missing.length > 0) {
    throw httpError(`Missing required template variables: ${missing.join(', ')}`, 400);
  }

  const extractor = runners.extractorFor(config, model, tmpl.model);
  const deps = runners.buildDeps(config, extractor);
  const startMs = Date.now();
  const res = await withTimeout(
    runners.cycle(tmpl, inputs, deps, { cycles: max_turns }),
    cycleTimeoutMs(tmpl.budget.wall_ms)
  );

  return {
    status: res.status,
    result: JSON.stringify(res.data),
    data: res.data,
    _meta: res._meta,
    steps: res.steps,
    turns: res.turns,
    cost_usd: res.cost_usd,
    elapsed_ms: Date.now() - startMs,
    model: res.model,
    template: tmpl.name,
  };
}

export async function executeRun(
  body: RunRequest,
  browserPool: BrowserPool,
  config: Config,
  runners: Runners = DEFAULT_RUNNERS
): Promise<RunResponse> {
  const { template: templateName, prompt, system_prompt, inputs = {}, prompt_extension, model, max_turns, mode } = body;

  if (max_turns !== undefined && (max_turns < 1 || max_turns > 10)) {
    throw httpError('max_turns must be between 1 and 10', 400);
  }
  if (mode !== undefined && mode !== 'react' && mode !== 'cycle') {
    throw httpError('mode must be "react" or "cycle"', 400);
  }

  let systemPrompt: string;
  let userPrompt: string;
  let resolvedModel: string;
  let resolvedMaxTurns: number;
  let resolvedTemplateName: string | undefined;
  let resolvedOutputFormat: 'text' | 'json' | undefined;

  if (templateName) {
    const any = getTemplateAny(templateName);
    if (!any && !getTemplate(templateName)) throw httpError(`Template not found: ${templateName}`, 404);

    const resolvedMode: RunMode = mode ?? (any?.version === 2 ? 'cycle' : 'react');
    if (resolvedMode === 'cycle') {
      if (!any || any.version !== 2) {
        throw httpError(`mode "cycle" requires a version 2 template; ${templateName} is v1`, 400);
      }
      return executeCycle(any.t, body, config, runners);
    }

    // react: a v1 template at the top level, or the templates/v1/ copy of a v2 name
    const tmpl = any?.version === 1 ? any.t : getTemplate(templateName);
    if (!tmpl) {
      throw httpError(`mode "react" needs a v1 template for ${templateName} (templates/v1/${templateName}.yaml is missing)`, 400);
    }

    const missingVars = validateInputs(tmpl, inputs);
    if (missingVars.length > 0) {
      throw Object.assign(
        new Error(`Missing required template variables: ${missingVars.join(', ')}`),
        { statusCode: 400 }
      );
    }

    const resolvedUserPrompt = resolvePrompt(tmpl, inputs);
    userPrompt = prompt_extension ? `${resolvedUserPrompt}\n\n${prompt_extension}` : resolvedUserPrompt;
    systemPrompt = tmpl.system_prompt;
    resolvedModel = model ?? tmpl.model ?? DEFAULT_MODEL;
    resolvedMaxTurns = max_turns ?? tmpl.max_turns ?? DEFAULT_MAX_TURNS;
    resolvedTemplateName = templateName;
    resolvedOutputFormat = (tmpl.output_format as 'text' | 'json') ?? undefined;
  } else if (prompt) {
    if (mode === 'cycle') throw httpError('inline "prompt" runs on the react loop only; mode "cycle" needs a version 2 template', 400);
    userPrompt = prompt_extension ? `${prompt}\n\n${prompt_extension}` : prompt;
    systemPrompt = system_prompt ?? DEFAULT_SYSTEM_PROMPT;
    resolvedModel = model ?? DEFAULT_MODEL;
    resolvedMaxTurns = max_turns ?? DEFAULT_MAX_TURNS;
    resolvedTemplateName = undefined;
    resolvedOutputFormat = undefined;
  } else {
    throw Object.assign(new Error('Either "template" or "prompt" must be provided'), { statusCode: 400 });
  }

  const startMs = Date.now();

  const agentPromise = runners.react({
    systemPrompt: withRuntimeContext(systemPrompt),
    userPrompt,
    model: resolvedModel,
    maxTurns: resolvedMaxTurns,
    pool: browserPool,
    apiKey: config.openrouterApiKey,
    outputFormat: resolvedOutputFormat,
  });

  const agentResult = await withTimeout(agentPromise);
  const elapsed_ms = Date.now() - startMs;

  const response: RunResponse = {
    status: agentResult.status,
    result:
      resolvedTemplateName === 'company_enrichment'
        ? sanitizeCompanyEnrichmentResult(agentResult.result)
        : resolvedTemplateName === 'find_founders'
          ? sanitizeFindFoundersResult(agentResult.result)
        : agentResult.result,
    steps: agentResult.steps,
    turns: agentResult.turns,
    cost_usd: agentResult.cost_usd,
    elapsed_ms,
    model: agentResult.model,
  };

  if (resolvedTemplateName) response.template = resolvedTemplateName;
  return response;
}

function runBatchAsync(
  jobId: string,
  body: BatchRequest,
  browserPool: BrowserPool,
  config: Config,
  runners: Runners
): void {
  const job = jobs.get(jobId)!;
  const queue = new PQueue({ concurrency: config.workerConcurrency });

  body.rows.forEach((rowInputs, rowIndex) => {
    queue.add(async () => {
      const runBody: RunRequest = {
        template: body.template,
        prompt: body.prompt,
        inputs: rowInputs,
        prompt_extension: body.prompt_extension,
        model: body.model,
        max_turns: body.max_turns,
        mode: body.mode,
      };

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= BATCH_ROW_ATTEMPTS; attempt++) {
        try {
          const result = await executeRun(runBody, browserPool, config, runners);
          recordRow(job, { ...result, row_index: rowIndex, inputs: rowInputs }, false);
          return;
        } catch (err) {
          lastError = err as Error;
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== undefined && status >= 400 && status < 500) break;
          // A 504 means the first run is STILL RUNNING (withTimeout cannot cancel
          // it). Retrying layered a second full run on top of the first (2.11).
          if (status === 504) break;
          if (attempt < BATCH_ROW_ATTEMPTS) {
            await sleep(500 * attempt);
          }
        }
      }

      if (lastError) {
        recordRow(
          job,
          {
            status: 'error',
            result: lastError.message,
            steps: [],
            turns: 0,
            cost_usd: 0,
            elapsed_ms: 0,
            model: body.model ?? DEFAULT_MODEL,
            row_index: rowIndex,
            inputs: rowInputs,
          },
          true
        );
      }
    });
  });

  const batchTimeout = setTimeout(() => {
    queue.clear();
    body.rows.forEach((rowInputs, rowIndex) => {
      recordRow(
        job,
        {
          status: 'error',
          result: 'Batch job timeout: row did not complete within time limit',
          steps: [],
          turns: 0,
          cost_usd: 0,
          elapsed_ms: 0,
          model: body.model ?? DEFAULT_MODEL,
          row_index: rowIndex,
          inputs: rowInputs,
        },
        true
      );
    });
    job.status = 'completed';
    job.finished_at = Date.now();
    job.results.sort((a, b) => a.row_index - b.row_index);
  }, BATCH_JOB_TIMEOUT_MS);

  queue.onIdle().then(() => {
    clearTimeout(batchTimeout);
    job.status = 'completed';
    job.finished_at = Date.now();
    job.results.sort((a, b) => a.row_index - b.row_index);
  });
}

export async function runRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions
): Promise<void> {
  const { browserPool, config } = options;
  const runners = options.runners ?? DEFAULT_RUNNERS;

  // POST /v1/run - single synchronous run (unchanged)
  app.post('/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as RunRequest;

    if (!body.template && !body.prompt) {
      return reply.code(400).send({ error: 'Either "template" or "prompt" must be provided' });
    }

    try {
      const result = await executeRun(body, browserPool, config, runners);
      if (result.status === 'error') return reply.code(502).send(result);
      return reply.send(result);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.code(error.statusCode ?? 500).send({ error: error.message });
    }
  });

  // POST /v1/run/batch - start async batch, returns job_id immediately
  app.post('/run/batch', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as BatchRequest;

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return reply.code(400).send({ error: '"rows" must be a non-empty array' });
    }
    if (body.rows.length > MAX_BATCH_ROWS) {
      return reply.code(400).send({ error: `Batch size exceeds maximum of ${MAX_BATCH_ROWS} rows (got ${body.rows.length})` });
    }
    if (!body.template && !body.prompt) {
      return reply.code(400).send({ error: 'Either "template" or "prompt" must be provided' });
    }

    const jobId = randomUUID();
    const job: Job = {
      id: jobId,
      status: 'running',
      total: body.rows.length,
      completed_count: 0,
      failed_count: 0,
      total_cost_usd: 0,
      results: [],
      recorded: new Set<number>(),
      started_at: Date.now(),
      expires_at: Date.now() + JOB_TTL_MS,
    };
    jobs.set(jobId, job);

    // Fire and forget - response returns immediately
    runBatchAsync(jobId, body, browserPool, config, runners);

    return reply.code(202).send({
      job_id: jobId,
      status: 'running',
      total: body.rows.length,
      poll_url: `/v1/run/batch/${jobId}`,
    });
  });

  // GET /v1/run/batch/:job_id - poll for results
  app.get('/run/batch/:job_id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { job_id } = request.params as { job_id: string };
    const job = jobs.get(job_id);

    if (!job) return reply.code(404).send({ error: `Job not found: ${job_id}` });

    const elapsed_ms = (job.finished_at ?? Date.now()) - job.started_at;

    return reply.send({
      job_id: job.id,
      status: job.status,
      total: job.total,
      completed: job.completed_count,
      failed: job.failed_count,
      total_cost_usd: job.total_cost_usd,
      elapsed_ms,
      results: job.status === 'completed' ? job.results : [],
    });
  });
}
