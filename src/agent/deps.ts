/**
 * Production wiring for the cycle engine: real browser layer, caches and a
 * per-(provider, model) extractor cache. Tests build CycleDeps by hand.
 */

import type { Config } from '../config.js';
import { configureDb, createPageCache, createResultCache, lookupProfiles, scrapeProfiles } from '../cache/index.js';
import { createExtractor, resolveExtractorModel, type Extractor, type Provider } from '../llm/index.js';
import { discoverAndFetch, fetchPage, pruneForQuestion, search } from './browser_deps.js';
import type { CycleDeps } from './cycle.js';
import { createJevDecider, type Decider } from '../llm/jev.js';

let decider: Decider | undefined;

let resultCache: ReturnType<typeof createResultCache> | undefined;
let pageCache: ReturnType<typeof createPageCache> | undefined;
let dbConfiguredFor: string | undefined | null = null;
const extractors = new Map<string, Extractor>();

function ensureCaches(config: Config): void {
  if (dbConfiguredFor !== config.databaseUrl) {
    configureDb(config.databaseUrl);
    dbConfiguredFor = config.databaseUrl;
  }
  resultCache ??= createResultCache();
  pageCache ??= createPageCache();
}

export function extractorFor(config: Config, requestedModel?: string, templateModel?: string): Extractor {
  const provider: Provider = config.llmProvider;
  const model = resolveExtractorModel(provider, requestedModel, templateModel);
  const key = `${provider}:${model}`;
  let ex = extractors.get(key);
  if (!ex) {
    ex = createExtractor(provider, model, {
      openrouterApiKey: config.openrouterApiKey,
      anthropicApiKey: config.anthropicApiKey,
    });
    extractors.set(key, ex);
  }
  return ex;
}

export function buildCycleDeps(config: Config, extractor: Extractor): CycleDeps {
  ensureCaches(config);
  return {
    search,
    fetchPage,
    discoverAndFetch,
    prune: pruneForQuestion,
    extractor,
    profiles: config.databaseUrl ? lookupProfiles : undefined,
    scrapeProfiles: config.databaseUrl && process.env['APIFY_API_TOKEN'] ? scrapeProfiles : undefined,
    decide: process.env['JEV_API_KEY'] ? (decider ??= createJevDecider(process.env['JEV_API_KEY'])) : undefined,
    resultCache,
    pageCache,
    codeVersion: config.codeVersion,
  };
}
