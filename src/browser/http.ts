/**
 * One HTTP helper for every tier: timeout, optional proxy agent, body byte cap.
 * Tests mock `node-fetch`'s default export and return a Response-like object
 * (`status`, `headers.get`, `url`, and either an async-iterable `body` or `text()`).
 */
import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const BODY_CAP_BYTES = 1_500_000;

export interface HttpRequest {
  timeoutMs: number;
  headers?: Record<string, string>;
  proxyUrl?: string;
  maxBytes?: number;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface HttpResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
}

export class BodyTooLargeError extends Error {
  constructor(bytes: number) {
    super(`body_too_large: exceeded ${bytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

interface ResponseLike {
  status: number;
  url?: string;
  headers?: { get(name: string): string | null };
  body?: unknown;
  text?: () => Promise<string>;
}

async function readCapped(response: ResponseLike, maxBytes: number): Promise<{ body: string; bytes: number; truncated: boolean }> {
  const declared = Number(response.headers?.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(declared);
  }

  const stream = response.body as AsyncIterable<Uint8Array> | null | undefined;
  if (stream && typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        const destroy = (stream as { destroy?: () => void }).destroy;
        if (typeof destroy === 'function') destroy.call(stream);
        throw new BodyTooLargeError(bytes);
      }
      chunks.push(buf);
    }
    return { body: Buffer.concat(chunks).toString('utf8'), bytes, truncated: false };
  }

  const text = typeof response.text === 'function' ? await response.text() : '';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) throw new BodyTooLargeError(bytes);
  return { body: text, bytes, truncated: false };
}

/** Test hook: exercise the streaming/cap/text-fallback branches without a network call. */
export function readCappedForTest(
  response: ResponseLike,
  maxBytes: number
): Promise<{ body: string; bytes: number; truncated: boolean }> {
  return readCapped(response, maxBytes);
}

export async function httpFetch(url: string, req: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const init: Record<string, unknown> = {
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      redirect: 'follow',
      signal: controller.signal,
    };
    if (req.body !== undefined) init['body'] = req.body;
    if (req.proxyUrl) init['agent'] = new HttpsProxyAgent(req.proxyUrl);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await nodeFetch(url, init as any)) as unknown as ResponseLike;
    const read = await readCapped(response, req.maxBytes ?? BODY_CAP_BYTES);
    return {
      status: response.status,
      url: response.url || url,
      contentType: response.headers?.get('content-type') ?? '',
      ...read,
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (controller.signal.aborted || /abort/i.test(msg)) {
      throw new Error(`timeout after ${req.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
