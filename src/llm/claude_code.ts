/**
 * claude_code extractor: runs the local `claude` CLI (Claude Code
 * subscription) per extraction call instead of an API key.
 *
 *   claude -p --model haiku --output-format json --json-schema '<schema>' \
 *          --tools "" --setting-sources "" --exclude-dynamic-system-prompt-sections \
 *          --system-prompt "<system>"      (user message on stdin)
 *
 * cwd is an empty directory so no CLAUDE.md or settings load (1.2k input
 * tokens per call instead of 50k). Cost is list-price accounting only; the
 * cycle marks `_meta.cost_basis: 'subscription'` for this provider.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJsonLoose } from './json_repair.js';
import { ProviderUnrecoverableError, sleep, type ExtractOptions, type ExtractResult, type Extractor, type JsonSchema } from './types.js';

export const CLAUDE_CODE_DEFAULT_MODEL = 'haiku';
export const CLAUDE_CODE_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 2000;

export type SpawnFn = typeof nodeSpawn;

export interface ClaudeCodeOptions {
  bin?: string;
  concurrency?: number;
  spawn?: SpawnFn;
  cwd?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface CliResult {
  structured_output?: unknown;
  result?: string;
  is_error?: boolean;
  subtype?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Map any template/request model id onto the CLI's haiku|sonnet aliases. */
export function claudeCodeModel(requested?: string): string {
  const m = (requested ?? '').toLowerCase();
  if (!m || m.includes('/')) return CLAUDE_CODE_DEFAULT_MODEL;
  if (m === 'haiku' || m.startsWith('claude-haiku')) return 'haiku';
  if (m === 'sonnet' || m.startsWith('claude-sonnet')) return 'sonnet';
  return CLAUDE_CODE_DEFAULT_MODEL;
}

let sharedCwd: string | undefined;

/** An empty directory under os.tmpdir(), created once, so the CLI loads no project context. */
export function claudeCodeCwd(): string {
  if (sharedCwd && fs.existsSync(sharedCwd)) return sharedCwd;
  sharedCwd = path.join(os.tmpdir(), 'yaygent-claude');
  fs.mkdirSync(sharedCwd, { recursive: true });
  return sharedCwd;
}

/**
 * The counter is moved by the RELEASER, never by the waiter's continuation.
 *
 * It used to be `release()` decrements, then the waiter's `await` continuation
 * increments a microtask later. Any caller arriving in that window saw a free
 * slot, took it, and the waiter then incremented on top - so under batch load
 * CLAUDE_CODE_CONCURRENCY drifted upward while a queue existed, which is the
 * likeliest way to trip the subscription limit (review 3.1). Releasing now
 * either hands the slot straight to the next waiter (count unchanged) or gives
 * it back (count down).
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  /** live count of handed-out slots (tests) */
  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // the slot was handed over by release(); `active` already accounts for it
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runCli(spawn: SpawnFn, bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`[llm] claude_code: binary "${bin}" not found (set CLAUDE_CODE_BIN or install the Claude Code CLI)`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
  });
}

/**
 * The CLI's own `subtype` is checked first; the message regex is the fallback for
 * the exit-code path, where all we have is stderr (review 3.5).
 */
const LIMIT_SUBTYPES = new Set([
  'error_usage_limit',
  'error_session_limit',
  'error_rate_limit',
  'usage_limit_reached',
  'rate_limit',
]);

export function isSubscriptionLimit(text: string): boolean {
  return /session limit|usage limit|rate limit.*resets|hit your limit/i.test(text);
}

function limitError(detail: string): ProviderUnrecoverableError {
  return new ProviderUnrecoverableError('claude_code', `[llm] claude_code: subscription limit reached - ${detail}`);
}

function parseCli(outcome: RunOutcome): CliResult {
  if (outcome.timedOut) throw new Error('[llm] claude_code: timed out, child killed');
  const parsed = parseJsonLoose(outcome.stdout) as CliResult | null;
  if (parsed?.subtype && LIMIT_SUBTYPES.has(parsed.subtype)) {
    throw limitError(`subtype ${parsed.subtype}: ${String(parsed.result ?? '').slice(0, 300)}`);
  }
  if (outcome.code !== 0 && outcome.code !== null) {
    const detail = parsed?.result ?? outcome.stderr.slice(0, 300);
    throw new Error(`[llm] claude_code: exit ${outcome.code}: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[llm] claude_code: non-JSON stdout: ${outcome.stdout.slice(0, 200)}`);
  }
  if (parsed.is_error) {
    throw new Error(`[llm] claude_code: is_error (${parsed.subtype ?? 'unknown'}): ${String(parsed.result ?? '').slice(0, 300)}`);
  }
  return parsed;
}

function toExtractResult(cli: CliResult): ExtractResult {
  let json: unknown = cli.structured_output;
  if (json === undefined || json === null) {
    json = typeof cli.result === 'string' ? parseJsonLoose(cli.result) : null;
  }
  if (json === null || json === undefined) {
    throw new Error('[llm] claude_code: no structured_output and result was not JSON');
  }
  return {
    json,
    raw: cli.structured_output !== undefined ? JSON.stringify(cli.structured_output) : String(cli.result ?? ''),
    usage: {
      in: cli.usage?.input_tokens ?? 0,
      out: cli.usage?.output_tokens ?? 0,
      cost_usd: cli.total_cost_usd ?? 0,
    },
  };
}

export function createClaudeCodeExtractor(model: string, opts: ClaudeCodeOptions = {}): Extractor {
  const bin = opts.bin ?? process.env['CLAUDE_CODE_BIN'] ?? 'claude';
  const spawn = opts.spawn ?? nodeSpawn;
  const semaphore = new Semaphore(opts.concurrency ?? envInt('CLAUDE_CODE_CONCURRENCY', 4));
  const cliModel = claudeCodeModel(model);
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;

  return {
    provider: 'claude_code',
    model: cliModel,
    async extract(schema: JsonSchema, system: string, user: string, extractOpts: ExtractOptions = {}): Promise<ExtractResult> {
      const args = [
        '-p',
        '--model',
        cliModel,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--tools',
        '',
        '--setting-sources',
        '',
        '--exclude-dynamic-system-prompt-sections',
        '--effort',
        process.env['CLAUDE_CODE_EFFORT'] ?? 'low',
        '--system-prompt',
        system,
      ];
      const cwd = opts.cwd ?? claudeCodeCwd();
      const timeoutMs = extractOpts.timeoutMs ?? opts.timeoutMs ?? CLAUDE_CODE_TIMEOUT_MS;

      const release = await semaphore.acquire();
      try {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const t0 = Date.now();
            const outcome = await runCli(spawn, bin, args, user, cwd, timeoutMs);
            const cli = parseCli(outcome);
            console.info(
              `[llm] claude_code ${cliModel} wall=${Date.now() - t0}ms api=${cli.duration_ms ?? '?'}ms in=${cli.usage?.input_tokens ?? '?'} out=${cli.usage?.output_tokens ?? '?'} user_chars=${user.length}`
            );
            return toExtractResult(cli);
          } catch (err) {
            lastError = err as Error;
            if (/not found/.test(lastError.message)) throw lastError;
            // A subscription limit is not a transient error: retrying burns the row's budget
            // and silently produces empty results across the whole batch.
            if (isSubscriptionLimit(lastError.message)) {
              console.error(`[llm] claude_code: SUBSCRIPTION LIMIT - ${lastError.message}`);
              throw new ProviderUnrecoverableError(
                'claude_code',
                `[llm] claude_code: subscription limit reached - ${lastError.message}`
              );
            }
            if (lastError instanceof ProviderUnrecoverableError) throw lastError;
            console.warn(`[llm] claude_code attempt ${attempt + 1} failed: ${lastError.message}`);
            if (attempt === 0) await sleep(retryDelay);
          }
        }
        throw lastError ?? new Error('[llm] claude_code: failed');
      } finally {
        release();
      }
    },
  };
}
