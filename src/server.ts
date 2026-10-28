import { timingSafeEqual } from 'crypto';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { type Config } from './config.js';
import { templatesRoutes } from './routes/templates.js';
import { runRoutes } from './routes/run.js';
import { browserPool } from './browser/index.js';

const VERSION = '0.1.0';
const startTime = Date.now();

/**
 * Returns available memory in bytes.
 * Reads RAILWAY_MEMORY_MB if set (Railway injects this), else assumes 512MB.
 */
function getAvailableMemoryBytes(): number {
  const railwayMb = process.env['RAILWAY_MEMORY_MB'];
  if (railwayMb) {
    const parsed = parseInt(railwayMb, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 1024 * 1024;
    }
  }
  return 512 * 1024 * 1024; // default 512MB
}

/** Path without query string or trailing slashes, so `/health?x=1` is still `/health`. */
export function requestPathname(url: string): string {
  const path = (url ?? '').split('?')[0].split('#')[0];
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

const PUBLIC_PATHS = new Set(['/health']);

function keyMatches(provided: string, allowed: string[]): boolean {
  const given = Buffer.from(provided);
  let ok = false;
  for (const key of allowed) {
    const expected = Buffer.from(key);
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

export function buildApp(config: Config) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  app.register(sensible);

  // Auth middleware - runs on all routes except /health.
  // The exemption matches on PATHNAME: an exact-string match made /health?x=1 a 401.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (PUBLIC_PATHS.has(requestPathname(request.url))) return;

    const apiKey = request.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string' || !keyMatches(apiKey, config.apiKeys)) {
      reply.code(401).send({ error: 'Invalid or missing API key' });
      return;
    }
  });

  // Health check - no auth required. It is the Railway healthcheck, so it reports whether
  // the service can actually do work, not just whether the process is up.
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const searchReady = Boolean(config.serperApiKey);
    const providerReady =
      config.llmProvider === 'openrouter'
        ? Boolean(config.openrouterApiKey)
        : config.llmProvider === 'anthropic'
          ? Boolean(config.anthropicApiKey)
          : true;
    const ready = searchReady && providerReady;
    // 503 only when the service cannot do ANY work (no extractor). A missing search key
    // is reported as `degraded` rather than restart-looping the deployment over it.
    if (!providerReady) reply.code(503);
    return {
      status: ready ? 'ok' : 'degraded',
      service: 'yaygent',
      version: VERSION,
      ready,
      search: { backend: 'serper', key_present: searchReady },
      llm: { provider: config.llmProvider, ready: providerReady },
      database: { configured: Boolean(config.databaseUrl) },
      browser_pool: {
        configured: browserPool.configuredSize,
        size: browserPool.size,
        available: browserPool.available,
      },
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    };
  });

  // Memory guard on batch endpoint - reject new large jobs when RSS > 80% of available RAM
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (requestPathname(request.url) === '/v1/run/batch' && request.method === 'POST') {
      const rss = process.memoryUsage().rss;
      const available = getAvailableMemoryBytes();
      if (rss > 0.8 * available) {
        const pct = ((rss / available) * 100).toFixed(1);
        request.log.warn({ rss, available, pct }, 'Memory pressure - rejecting batch request');
        reply.code(503).send({ error: 'Server under memory pressure, retry later', rss, available });
        return;
      }
    }
  });

  // Register route modules
  app.register(templatesRoutes, { prefix: '/v1' });
  app.register(runRoutes, { prefix: '/v1', browserPool, config });

  return app;
}

export async function startServer(config: Config): Promise<void> {
  const app = buildApp(config);

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Yaygent v${VERSION} listening on port ${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Initialize browser pool after server starts listening
  try {
    await browserPool.initialize();
    app.log.info(`Browser pool initialized (size: ${config.browserPoolSize})`);
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize browser pool');
    // Don't exit - service can still handle template routes without browser
  }

  // A single unhandled rejection used to kill the process under Node 20 defaults, taking
  // every in-memory batch job with it. Log and keep serving.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'Unhandled promise rejection - continuing');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception - continuing');
  });

  let shuttingDown = false;
  // HTTP first, browser second: closing the pool first pulled the contexts out from under
  // in-flight requests.
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down gracefully`);
    try {
      await app.close();
      app.log.info('HTTP server closed and drained');
    } catch (err) {
      app.log.error({ err }, 'Error closing the HTTP server');
    }
    try {
      await browserPool.close();
      app.log.info('Browser pool closed');
    } catch (err) {
      app.log.error({ err }, 'Error closing browser pool');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
