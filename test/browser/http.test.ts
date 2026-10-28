import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import nodeFetch from 'node-fetch';
import { httpFetch, readCappedForTest, BodyTooLargeError, BODY_CAP_BYTES } from '../../src/browser/http.js';

const fetchMock = nodeFetch as unknown as ReturnType<typeof vi.fn>;

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part, 'utf8');
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('readCapped', () => {
  it('reads a streaming body and counts its bytes', async () => {
    const read = await readCappedForTest({ status: 200, body: chunks('hello ', 'world') }, BODY_CAP_BYTES);
    expect(read.body).toBe('hello world');
    expect(read.bytes).toBe(11);
  });

  it('rejects on the declared content-length before reading a byte', async () => {
    let pulled = false;
    const response = {
      status: 200,
      headers: headers({ 'content-length': String(BODY_CAP_BYTES + 1) }),
      // eslint-disable-next-line require-yield
      body: (async function* () {
        pulled = true;
      })(),
    };
    await expect(readCappedForTest(response, BODY_CAP_BYTES)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBe(false);
  });

  it('aborts mid-stream once the cap is passed and destroys the stream', async () => {
    let destroyed = false;
    const stream = chunks('a'.repeat(40), 'b'.repeat(40)) as AsyncGenerator<Buffer> & { destroy?: () => void };
    stream.destroy = () => {
      destroyed = true;
    };
    await expect(readCappedForTest({ status: 200, body: stream }, 50)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(destroyed).toBe(true);
  });

  it('falls back to text() when there is no stream, and still caps', async () => {
    const read = await readCappedForTest({ status: 200, text: async () => 'plain' }, 100);
    expect(read.body).toBe('plain');
    expect(read.bytes).toBe(5);
    await expect(readCappedForTest({ status: 200, text: async () => 'x'.repeat(101) }, 100)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });
});

describe('httpFetch', () => {
  it('reports the FINAL url after redirects and the content type', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      url: 'https://acme.test/landing',
      headers: headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<html></html>',
    });
    const res = await httpFetch('https://acme.test/go', { timeoutMs: 1000 });
    expect(res.url).toBe('https://acme.test/landing');
    expect(res.contentType).toBe('text/html; charset=utf-8');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('follow');
  });

  it('falls back to the requested url when the response carries none', async () => {
    fetchMock.mockResolvedValueOnce({ status: 204, headers: headers({}), text: async () => '' });
    const res = await httpFetch('https://acme.test/x', { timeoutMs: 1000 });
    expect(res.url).toBe('https://acme.test/x');
    expect(res.contentType).toBe('');
  });

  it('attaches a proxy agent only when a proxy url is given', async () => {
    fetchMock.mockResolvedValue({ status: 200, headers: headers({}), text: async () => 'ok' });
    await httpFetch('https://acme.test', { timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][1].agent).toBeUndefined();
    await httpFetch('https://acme.test', { timeoutMs: 1000, proxyUrl: 'http://u:p@proxy.test:8080' });
    expect(fetchMock.mock.calls[1][1].agent).toBeDefined();
  });

  it('turns an abort into a readable timeout error', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('The operation was aborted');
    });
    await expect(httpFetch('https://slow.test', { timeoutMs: 1234 })).rejects.toThrow('timeout after 1234ms');
  });

  it('sends a POST body and headers through unchanged', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, headers: headers({}), text: async () => '{}' });
    await httpFetch('https://api.test', {
      timeoutMs: 1000,
      method: 'POST',
      body: '{"q":"x"}',
      headers: { 'X-API-KEY': 'k' },
    });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"q":"x"}');
    expect(init.headers['X-API-KEY']).toBe('k');
  });
});
