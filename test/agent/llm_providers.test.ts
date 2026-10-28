import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createClaudeCodeExtractor, claudeCodeModel, type SpawnFn } from '../../src/llm/claude_code.js';
import { resolveExtractorModel, anthropicCostUsd, parseJsonLoose } from '../../src/llm/index.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

interface Scripted {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

/** Builds a spawn() whose n-th call behaves per script[n]; records args + stdin. */
function fakeSpawn(script: Scripted[]) {
  const calls: Array<{ bin: string; args: string[]; stdin: string; cwd?: string }> = [];
  const children: FakeChild[] = [];
  const spawn = ((bin: string, args: string[], opts: { cwd?: string }) => {
    const step = script[calls.length] ?? {};
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    const record = { bin, args, stdin: '', cwd: opts.cwd };
    calls.push(record);
    children.push(child);
    child.stdin.on('data', (d: Buffer) => {
      record.stdin += d.toString();
    });
    child.kill = vi.fn(() => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
      return true;
    });
    child.stdin.on('finish', () => {
      if (step.hang) return;
      setImmediate(() => {
        if (step.stdout) child.stdout.write(step.stdout);
        if (step.stderr) child.stderr.write(step.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', step.code ?? 0);
      });
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls, children };
}

const FIXTURE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1800,
  result: '{"fields":{"vertical":{"value":"SaaS"}}}',
  structured_output: { fields: { vertical: { value: 'SaaS', quote: 'SaaS platform', source_ref: '[1]', confidence: 0.8 } } },
  total_cost_usd: 0.0031,
  usage: { input_tokens: 1171, output_tokens: 44 },
  modelUsage: {},
};

const SCHEMA = { type: 'object', properties: { fields: { type: 'object' } } };

describe('claude_code extractor', () => {
  it('spawns the CLI with the documented flags, sends the user message on stdin, returns structured_output', async () => {
    const { spawn, calls } = fakeSpawn([{ stdout: JSON.stringify(FIXTURE) }]);
    const ex = createClaudeCodeExtractor('claude-haiku-4-5', { spawn, bin: 'claude-test', cwd: '/tmp/empty' });
    expect(ex.provider).toBe('claude_code');
    expect(ex.model).toBe('haiku');

    const res = await ex.extract(SCHEMA, 'SYS', 'USER MESSAGE');
    expect(res.json).toEqual(FIXTURE.structured_output);
    expect(res.usage).toEqual({ in: 1171, out: 44, cost_usd: 0.0031 });

    expect(calls.length).toBe(1);
    const { bin, args, stdin, cwd } = calls[0];
    expect(bin).toBe('claude-test');
    expect(cwd).toBe('/tmp/empty');
    expect(stdin).toBe('USER MESSAGE');
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--output-format', 'json']);
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(SCHEMA));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    // no positional prompt: the message goes via stdin
    expect(args[args.length - 1]).toBe('SYS');
  });

  it('falls back to parsing `result` when structured_output is missing', async () => {
    const { structured_output: _drop, ...noStructured } = FIXTURE;
    void _drop;
    const { spawn } = fakeSpawn([{ stdout: JSON.stringify(noStructured) }]);
    const ex = createClaudeCodeExtractor('sonnet', { spawn, cwd: '/tmp/empty' });
    expect(ex.model).toBe('sonnet');
    const res = await ex.extract(SCHEMA, 's', 'u');
    expect(res.json).toEqual({ fields: { vertical: { value: 'SaaS' } } });
  });

  it('retries once after is_error, then throws', async () => {
    const errOut = JSON.stringify({ ...FIXTURE, is_error: true, subtype: 'error_during_execution', result: 'boom' });
    const { spawn, calls } = fakeSpawn([{ stdout: errOut }, { stdout: errOut }]);
    const ex = createClaudeCodeExtractor('haiku', { spawn, cwd: '/tmp/empty', retryDelayMs: 1 });
    await expect(ex.extract(SCHEMA, 's', 'u')).rejects.toThrow(/is_error/);
    expect(calls.length).toBe(2);
  });

  it('retries once after a non-zero exit and succeeds on the second try', async () => {
    const { spawn, calls } = fakeSpawn([{ stdout: '', code: 1 }, { stdout: JSON.stringify(FIXTURE) }]);
    const ex = createClaudeCodeExtractor('haiku', { spawn, cwd: '/tmp/empty', retryDelayMs: 1 });
    const res = await ex.extract(SCHEMA, 's', 'u');
    expect(res.json).toEqual(FIXTURE.structured_output);
    expect(calls.length).toBe(2);
  });

  it('kills the child on timeout', async () => {
    const { spawn, children } = fakeSpawn([{ hang: true }, { hang: true }]);
    const ex = createClaudeCodeExtractor('haiku', { spawn, cwd: '/tmp/empty', timeoutMs: 20, retryDelayMs: 1 });
    await expect(ex.extract(SCHEMA, 's', 'u')).rejects.toThrow(/timed out/);
    expect(children.length).toBe(2);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(children[1].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports a clear error when the binary is missing (no retry)', async () => {
    const calls: unknown[] = [];
    const spawn = ((bin: string) => {
      calls.push(bin);
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' })));
      return child;
    }) as unknown as SpawnFn;
    const ex = createClaudeCodeExtractor('haiku', { spawn, bin: 'nope', cwd: '/tmp/empty' });
    await expect(ex.extract(SCHEMA, 's', 'u')).rejects.toThrow(/not found/);
    expect(calls.length).toBe(1);
  });

  it('caps concurrent spawns with the semaphore', async () => {
    let active = 0;
    let peak = 0;
    const spawn = ((_bin: string, _args: string[]) => {
      active++;
      peak = Math.max(peak, active);
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('finish', () => {
        setTimeout(() => {
          active--;
          child.stdout.end(JSON.stringify(FIXTURE));
          child.emit('close', 0);
        }, 5);
      });
      return child;
    }) as unknown as SpawnFn;
    const ex = createClaudeCodeExtractor('haiku', { spawn, cwd: '/tmp/empty', concurrency: 2 });
    await Promise.all([1, 2, 3, 4, 5].map(() => ex.extract(SCHEMA, 's', 'u')));
    expect(peak).toBe(2);
  });

  it('maps model ids onto haiku|sonnet', () => {
    expect(claudeCodeModel('openai/gpt-oss-120b')).toBe('haiku');
    expect(claudeCodeModel('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeCodeModel('claude-sonnet-5')).toBe('sonnet');
    expect(claudeCodeModel(undefined)).toBe('haiku');
    expect(resolveExtractorModel('claude_code', undefined, 'openai/gpt-oss-120b')).toBe('haiku');
  });
});

describe('provider helpers', () => {
  it('resolves models per provider: request > template > default; OpenRouter ids swapped on anthropic', () => {
    expect(resolveExtractorModel('openrouter', undefined, undefined)).toBe('openai/gpt-oss-120b');
    expect(resolveExtractorModel('openrouter', 'x/y', 'a/b')).toBe('x/y');
    expect(resolveExtractorModel('anthropic', undefined, 'openai/gpt-oss-120b')).toBe('claude-haiku-4-5-20251001');
    expect(resolveExtractorModel('anthropic', 'claude-sonnet-5', 'openai/gpt-oss-120b')).toBe('claude-sonnet-5');
  });

  it('prices haiku 4.5 at $1/$5 per MTok', () => {
    expect(anthropicCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0)).toBe(1);
    expect(anthropicCostUsd('claude-haiku-4-5-20251001', 0, 1_000_000)).toBe(5);
    expect(anthropicCostUsd('claude-haiku-4-5-20251001', 2100, 250)).toBeCloseTo(0.00335, 8);
  });

  it('JSON repair strips fences, channel tags and leading prose', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('<|channel|>final<|message|>Sure: {"a":[1,2]} done')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose('not json at all')).toBeNull();
  });
});

describe('claude_code subscription limit', () => {
  it('does not retry and surfaces the limit', async () => {
    const { spawn, calls } = fakeSpawn([
      { stdout: '', stderr: "You've hit your session limit \u00b7 resets 2pm (Asia/Bangkok)", code: 1 },
      { stdout: JSON.stringify(FIXTURE) },
    ]);
    const ex = createClaudeCodeExtractor('haiku', { spawn, cwd: '/tmp/empty', retryDelayMs: 1 });
    await expect(ex.extract(SCHEMA, 's', 'u')).rejects.toThrow(/subscription limit/i);
    expect(calls.length).toBe(1);
  });
});
