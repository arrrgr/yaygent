import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.hoisted(() => {
  // limits.ts reads these at import time; the unkeyed default (15 RPM) would add 4s per Jina call
  process.env['JINA_RPM'] = '60000';
  process.env['SERPER_QPS'] = '1000';
});

import nodeFetch from 'node-fetch';
import {
  fetchPage,
  discoverAndFetch,
  normalizeUrl,
  pickFollowLink,
  visitPage,
  _clock,
  _clearPageCache,
  type PageCacheEntry,
  type PageCacheHook,
} from '../../src/browser/visit.js';
import { hostSemaphore } from '../../src/limits.js';
import { BodyTooLargeError } from '../../src/browser/http.js';

const fetchMock = nodeFetch as unknown as ReturnType<typeof vi.fn>;

function page(title: string, extra = ''): string {
  const filler = `<p>${`${title} builds software for teams that need reliable tooling. `.repeat(12)}</p>`;
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${filler}${extra}</main></body></html>`;
}

function htmlResponse(status: number, body: string, url: string, contentType = 'text/html; charset=utf-8') {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

let now = 0;

beforeEach(() => {
  fetchMock.mockReset();
  _clearPageCache();
  now = 1_000_000;
  _clock.now = () => now;
  process.env['PROXY_URL_ROTATE'] = 'http://user-rotate:pass@proxy.test:8080';
  process.env['BROWSER_POOL_SIZE'] = '0';
  delete process.env['JINA_API_KEY'];
  delete process.env['SERPER_API_KEY'];
});

afterEach(() => {
  _clock.now = () => Date.now();
  delete process.env['PROXY_URL_ROTATE'];
  delete process.env['PROXY_URL'];
  delete process.env['BROWSER_POOL_SIZE'];
});

describe('normalizeUrl', () => {
  it('lowercases host, forces https, strips tracking params, fragment and trailing slash', () => {
    expect(normalizeUrl('HTTP://Example.com/About/?utm_source=x&b=2&fbclid=1#frag')).toBe('https://example.com/About?b=2');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://www.Example.com/path/')).toBe('https://www.example.com/path');
    expect(normalizeUrl('http://example.com:80/x')).toBe('https://example.com/x');
  });

  it('throws on empty input', () => {
    expect(() => normalizeUrl('  ')).toThrow();
  });

  it('keeps a hash route and does not turn %20 into +', () => {
    expect(normalizeUrl('https://ex.com/#/spa/route')).toBe('https://ex.com/#/spa/route');
    expect(normalizeUrl('https://ex.com/#top')).toBe('https://ex.com');
    expect(normalizeUrl('https://ex.com/s?q=big%20data&utm_source=x')).toBe('https://ex.com/s?q=big%20data');
  });
});

describe('fetchPage', () => {
  it('returns direct content on a clean 200', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200, page('Acme'), 'https://acme.test'));
    const result = await fetchPage('acme.test');
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('direct');
    expect(result.markdown).toContain('Acme builds software');
    expect(result.tiers_tried).toEqual(['direct']);
    expect(result.bytes_by_tier['direct']).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('escalates 403 -> proxy (2 attempts) -> jina', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(403, 'Forbidden', 'https://blocked.test'))
      .mockResolvedValueOnce(htmlResponse(403, 'Forbidden', 'https://blocked.test'))
      .mockResolvedValueOnce(htmlResponse(200, CLOUDFLARE, 'https://blocked.test'))
      .mockResolvedValueOnce(
        htmlResponse(200, `# Blocked Co\n\n${'Blocked Co makes widgets for manufacturers. '.repeat(10)}`, 'https://r.jina.ai/https://blocked.test', 'text/plain')
      );

    const result = await fetchPage('https://blocked.test/');
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('jina');
    expect(result.tiers_tried).toEqual(['direct', 'proxy', 'proxy', 'jina']);
    expect(result.markdown).toContain('Blocked Co makes widgets');

    // proxy attempts carried the proxy agent; direct and jina did not
    expect(fetchMock.mock.calls[0][1].agent).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].agent).toBeDefined();
    expect(fetchMock.mock.calls[2][1].agent).toBeDefined();
    expect(fetchMock.mock.calls[3][0]).toBe('https://r.jina.ai/https://blocked.test');
    expect(fetchMock.mock.calls[3][1].agent).toBeUndefined();
  });

  it('sends the Jina API key as a bearer token when set', async () => {
    process.env['JINA_API_KEY'] = 'jina-secret';
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(htmlResponse(200, 'x '.repeat(300), 'https://r.jina.ai/https://flaky.test', 'text/plain'));
    const result = await fetchPage('https://flaky.test');
    expect(result.tier).toBe('jina');
    expect(fetchMock.mock.calls[3][1].headers['Authorization']).toBe('Bearer jina-secret');
  });

  it('never returns a challenge page as success', async () => {
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockResolvedValueOnce(htmlResponse(200, CLOUDFLARE, 'https://cf.test'))
      .mockResolvedValueOnce(htmlResponse(200, CLOUDFLARE, 'https://r.jina.ai/https://cf.test', 'text/plain'));
    const result = await fetchPage('https://cf.test');
    expect(result.ok).toBe(false);
    expect(result.tier).toBe('none');
    expect(result.tiers_tried).toEqual(['direct', 'jina']);
    expect(result.error).toMatch(/challenge/);
  });

  it('skips tiers that do not fit in the remaining budget (14s elapsed skips proxy and jina)', async () => {
    fetchMock.mockImplementationOnce(async () => {
      now += 14_000;
      return htmlResponse(403, 'Forbidden', 'https://slow.test');
    });
    const result = await fetchPage('https://slow.test', { budgetMs: 15_000 });
    expect(result.ok).toBe(false);
    expect(result.tiers_tried).toEqual(['direct']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('jina skipped (budget)');
    expect(result.elapsed_ms).toBe(14_000);
  });

  it('stops on 404 without escalating', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(404, '<html><body>nope</body></html>', 'https://gone.test/x'));
    const result = await fetchPage('https://gone.test/x');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.tiers_tried).toEqual(['direct']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('goes to Jina (not proxy) when direct returns thin content', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(200, '<html><body><div id="app"></div></body></html>', 'https://spa.test'))
      .mockResolvedValueOnce(htmlResponse(200, 'Rendered content. '.repeat(30), 'https://r.jina.ai/https://spa.test', 'text/plain'));
    const result = await fetchPage('https://spa.test');
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('jina');
    expect(result.tiers_tried).toEqual(['direct', 'jina']);
  });

  it('blocks linkedin.com/in/ URLs immediately', async () => {
    const result = await fetchPage('https://www.linkedin.com/in/jane-doe/');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('linkedin_blocked');
    expect(result.tier).toBe('none');
    expect(result.tiers_tried).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the cache hook before any network tier and writes back on success', async () => {
    const stored: PageCacheEntry[] = [];
    const entry: PageCacheEntry = {
      url_norm: 'https://cached.test',
      url_final: 'https://cached.test',
      status: 200,
      tier: 'direct',
      bytes: 1000,
      markdown: 'cached markdown '.repeat(40),
      fetched_at: new Date().toISOString(),
    };
    const hook: PageCacheHook = {
      get: async (urlNorm) => (urlNorm === entry.url_norm ? entry : null),
      set: (e) => {
        stored.push(e);
      },
    };

    const hit = await fetchPage('cached.test', { cache: hook });
    expect(hit.ok).toBe(true);
    expect(hit.tier).toBe('cache');
    expect(hit.cached).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(htmlResponse(200, page('Fresh'), 'https://fresh.test'));
    const miss = await fetchPage('https://fresh.test', { cache: hook });
    expect(miss.tier).toBe('direct');
    expect(stored).toHaveLength(1);
    expect(stored[0].url_norm).toBe('https://fresh.test');
    expect(stored[0].markdown.length).toBeGreaterThanOrEqual(500);

    // second call for the same URL is served from the in-process LRU
    const again = await fetchPage('https://fresh.test/', { cache: hook });
    expect(again.tier).toBe('cache');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache thin or failed pages', async () => {
    const stored: PageCacheEntry[] = [];
    const hook: PageCacheHook = { get: async () => null, set: (e) => void stored.push(e) };
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockResolvedValueOnce(htmlResponse(500, 'err', 'https://err.test'))
      .mockResolvedValueOnce(htmlResponse(502, 'err', 'https://r.jina.ai/https://err.test', 'text/plain'));
    const result = await fetchPage('https://err.test', { cache: hook });
    expect(result.ok).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('host_busy skips only the semaphore-gated tiers and still lets Jina run', async () => {
    // Jina goes out over Jina's own IPs and holds no host slot, so a saturated target host
    // must not take the whole visit down with it (design 2.2).
    const r1 = await hostSemaphore.acquire('busy.test');
    const r2 = await hostSemaphore.acquire('busy.test');
    _clock.now = () => Date.now();
    fetchMock.mockResolvedValueOnce(
      htmlResponse(200, `# Busy Co\n\n${'Busy Co makes widgets for manufacturers. '.repeat(10)}`, 'https://r.jina.ai/https://busy.test', 'text/plain')
    );
    const result = await fetchPage('https://busy.test', { budgetMs: 30_000 });
    r1();
    r2();
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('jina');
    expect(result.tiers_tried).toEqual(['direct', 'jina']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://r.jina.ai/https://busy.test');
    // the proxy tier is semaphore-gated too, so it never ran
    expect(fetchMock.mock.calls.every((c: unknown[]) => (c[1] as { agent?: unknown }).agent === undefined)).toBe(true);
  }, 15_000);

  it('charges the host-semaphore wait against the visit budget', async () => {
    // Two slots held for ~500ms, budget 1700ms: after the wait there is less than one
    // minimum tier left, so the tier gives up instead of overrunning the budget by 5s.
    const r1 = await hostSemaphore.acquire('slowsem.test');
    const r2 = await hostSemaphore.acquire('slowsem.test');
    setTimeout(() => {
      r1();
      r2();
    }, 500);
    _clock.now = () => Date.now();
    const result = await fetchPage('https://slowsem.test', { budgetMs: 1_700 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget_after_host_wait|budget/);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);

  it('never rejects, and never leaks the host slot, when the browser pool throws', async () => {
    const stubPool = {
      configuredSize: 2,
      size: 2,
      initialize: async () => {},
      acquire: async () => {
        throw new Error('pool exploded');
      },
      release: () => {},
      discard: () => {},
    } as unknown as import('../../src/browser/pool.js').BrowserPool;

    _clock.now = () => Date.now();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // every other tier fails cleanly so the assertion is about playwright only
    fetchMock.mockResolvedValue(htmlResponse(500, 'err', 'https://pwtest.example'));

    const result = await fetchPage('https://pwtest.example', { jsRequired: true, pool: stubPool, budgetMs: 12_000 });

    expect(result.ok).toBe(false);
    expect(result.tiers_tried[0]).toBe('playwright');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('pool exploded'))).toBe(true);
    // the host slot the tier took must be back, or HOST_LIMIT=2 failures kill the host
    expect(hostSemaphore.activeFor('pwtest.example')).toBe(0);
    warn.mockRestore();
  }, 15_000);

  it('rejects private, loopback, link-local and *.internal hosts before any request', async () => {
    for (const url of [
      'http://127.0.0.1:8080/admin',
      'https://10.1.2.3/',
      'https://192.168.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://yaygent.railway.internal/',
      'http://localhost:3000/',
      'https://[::1]/',
    ]) {
      const result = await fetchPage(url);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('blocked_host');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => normalizeUrl('https://8.8.8.8/')).not.toThrow();
  });

  it('re-applies the LinkedIn block to the final url after a redirect', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(200, page('Profile'), 'https://www.linkedin.com/in/jane-doe')
    );
    const result = await fetchPage('https://acme.test/team');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('linkedin_blocked (redirect)');
    expect(result.markdown).toBe('');
  });

  it('re-applies the host semaphore to the redirect target', async () => {
    let activeDuringParse = -1;
    fetchMock.mockImplementationOnce(async () => {
      return {
        status: 200,
        ok: true,
        url: 'https://redirected.test/landing',
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
        text: async () => {
          activeDuringParse = hostSemaphore.activeFor('redirected.test');
          return page('Redirected');
        },
      };
    });
    _clock.now = () => Date.now();
    const result = await fetchPage('https://origin.test/go');
    expect(result.ok).toBe(true);
    expect(result.url_final).toBe('https://redirected.test/landing');
    // the slot is taken after the body is read and released before we return
    expect(activeDuringParse).toBe(0);
    expect(hostSemaphore.activeFor('redirected.test')).toBe(0);
    expect(hostSemaphore.activeFor('origin.test')).toBe(0);
  });

  it('escalates a body over the cap instead of stopping the visit', async () => {
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockImplementationOnce(async () => {
        throw new BodyTooLargeError(2_000_000);
      })
      .mockResolvedValueOnce(
        htmlResponse(200, `# Heavy Co\n\n${'Heavy Co sells industrial equipment. '.repeat(10)}`, 'https://r.jina.ai/https://heavy.test', 'text/plain')
      );
    const result = await fetchPage('https://heavy.test');
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('jina');
    expect(result.tiers_tried).toEqual(['direct', 'jina']);
  });
});

describe('tier ladder budget', () => {
  it('drops the second proxy attempt so Jina still runs inside a 15s budget', async () => {
    // direct times out (5s) -> proxy attempt 1 fails (5s) -> 5s left, which cannot cover
    // proxy(5s) AND jina, so attempt 2 is dropped and Jina gets the rest.
    fetchMock
      .mockImplementationOnce(async () => {
        now += 5_000;
        throw new Error('timeout after 5000ms');
      })
      .mockImplementationOnce(async () => {
        now += 5_000;
        throw new Error('timeout after 5000ms');
      })
      .mockResolvedValueOnce(
        htmlResponse(200, `# Slow Co\n\n${'Slow Co makes conveyor belts for warehouses. '.repeat(10)}`, 'https://r.jina.ai/https://slow.test', 'text/plain')
      );

    const result = await fetchPage('https://slow.test', { budgetMs: 15_000 });
    expect(result.tiers_tried).toEqual(['direct', 'proxy', 'jina']);
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('jina');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe('https://r.jina.ai/https://slow.test');
  });

  it('still runs both proxy attempts when the budget can cover the next tier too', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(403, 'Forbidden', 'https://blocked.test'))
      .mockResolvedValueOnce(htmlResponse(403, 'Forbidden', 'https://blocked.test'))
      .mockResolvedValueOnce(htmlResponse(403, 'Forbidden', 'https://blocked.test'))
      .mockResolvedValueOnce(
        htmlResponse(200, `# Blocked\n\n${'Blocked Co makes widgets. '.repeat(20)}`, 'https://r.jina.ai/https://blocked.test', 'text/plain')
      );
    const result = await fetchPage('https://blocked.test', { budgetMs: 40_000 });
    expect(result.tiers_tried).toEqual(['direct', 'proxy', 'proxy', 'jina']);
    expect(result.ok).toBe(true);
  });
});

describe('pickFollowLink / discoverAndFetch', () => {
  const HOME = `<!doctype html><html><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="https://twitter.com/acme">Twitter</a><a href="/about-us">Company</a><a href="/blog">Blog</a></nav>
<main><h1>Acme</h1>${'<p>Acme builds billing software for SaaS teams that need reliable revenue tooling.</p>'.repeat(6)}</main>
</body></html>`;

  it('picks the first internal anchor matching a follow word in text or href', () => {
    expect(pickFollowLink(HOME, 'https://acme.test', ['about', 'team'])).toBe('https://acme.test/about-us');
    expect(pickFollowLink(HOME, 'https://acme.test', ['company'])).toBe('https://acme.test/about-us');
    expect(pickFollowLink(HOME, 'https://acme.test', ['founders'])).toBeUndefined();
    expect(pickFollowLink('<a href="/our-team/">Meet us</a>', 'https://www.acme.test', ['team'])).toBe('https://www.acme.test/our-team/');
  });

  it('ignores external and homepage links', () => {
    expect(pickFollowLink('<a href="https://twitter.com/about">about</a><a href="/">About</a>', 'https://acme.test', ['about'])).toBeUndefined();
  });

  it('matches path SEGMENTS, not a substring of the whole path', () => {
    // `story` used to select /our-history ("hi-story") and `about` a blog post.
    expect(pickFollowLink('<a href="/our-history">Our history</a>', 'https://acme.test', ['story'])).toBeUndefined();
    expect(pickFollowLink('<a href="/our-story">Our story</a>', 'https://acme.test', ['story'])).toBe('https://acme.test/our-story');
    expect(pickFollowLink('<a href="/blog/about-our-series-a">About our Series A</a>', 'https://acme.test', ['about'])).toBeUndefined();
    expect(pickFollowLink('<a href="/legal/company-privacy-policy">Company policy</a>', 'https://acme.test', ['company'])).toBeUndefined();
    expect(pickFollowLink('<a href="/about-cookies">About cookies</a>', 'https://acme.test', ['about'])).toBeUndefined();
  });

  it('honours the priority order of the follow list, not document order', () => {
    const html = '<nav><a href="/about-us">About us</a><a href="/team">Team</a></nav>';
    expect(pickFollowLink(html, 'https://acme.test', ['team', 'about'])).toBe('https://acme.test/team');
    expect(pickFollowLink(html, 'https://acme.test', ['about', 'team'])).toBe('https://acme.test/about-us');
  });

  it('works on markdown links too (Jina output)', () => {
    const md = '[Home](https://acme.test/) [About us](https://acme.test/about) [LinkedIn](https://linkedin.com/company/acme)';
    expect(pickFollowLink(md, 'https://acme.test', ['about'])).toBe('https://acme.test/about');
  });

  it('fetches the homepage then the discovered page', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(200, HOME, 'https://acme.test'))
      .mockResolvedValueOnce(htmlResponse(200, page('About Acme', '<p>Founded by Jane Doe in 2015.</p>'), 'https://acme.test/about-us'));
    const result = await discoverAndFetch('https://acme.test', ['about', 'team', 'leadership']);
    expect(result.ok).toBe(true);
    expect(result.discovered_url).toBe('https://acme.test/about-us');
    expect(result.markdown).toContain('Founded by Jane Doe');
    expect(result.tiers_tried).toEqual(['direct', 'direct']);
    expect(fetchMock.mock.calls[1][0]).toBe('https://acme.test/about-us');
  });

  it('returns the homepage when nothing matches', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200, HOME, 'https://acme.test'));
    const result = await discoverAndFetch('https://acme.test', ['founders']);
    expect(result.ok).toBe(true);
    expect(result.discovered_url).toBeUndefined();
    expect(result.markdown).toContain('Acme builds billing software');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps ONE total budget and merges the homepage byte accounting', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        now += 6_000;
        return htmlResponse(200, HOME, 'https://acme.test');
      })
      .mockResolvedValueOnce(htmlResponse(200, page('About Acme', '<p>Founded by Jane Doe in 2015.</p>'), 'https://acme.test/about-us'));

    const result = await discoverAndFetch('https://acme.test', ['about'], { budgetMs: 15_000 });
    expect(result.ok).toBe(true);
    // the homepage spent 6s of the 15s, so the about page gets 9s, not another 15s
    expect(result.elapsed_ms).toBeLessThanOrEqual(15_000);
    // bytes from BOTH fetches are reported, not just the second page's
    expect(result.bytes_by_tier['direct']).toBeGreaterThan(0);
    expect(result.bytes_by_tier['direct']).toBeGreaterThan(Buffer.byteLength(page('About Acme'), 'utf8'));
  });

  it('returns the homepage rather than overrunning when the homepage ate the budget', async () => {
    fetchMock.mockImplementationOnce(async () => {
      now += 14_900;
      return htmlResponse(200, HOME, 'https://acme.test');
    });
    const result = await discoverAndFetch('https://acme.test', ['about'], { budgetMs: 15_000 });
    expect(result.ok).toBe(true);
    expect(result.discovered_url).toBe('https://acme.test/about-us');
    expect(result.error).toMatch(/budget/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the homepage result when the discovered page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(200, HOME, 'https://acme.test'))
      .mockResolvedValueOnce(htmlResponse(404, 'gone', 'https://acme.test/about-us'));
    const result = await discoverAndFetch('https://acme.test', ['about']);
    expect(result.ok).toBe(true);
    expect(result.discovered_url).toBe('https://acme.test/about-us');
    expect(result.error).toMatch(/discovered_fetch_failed/);
  });
});

describe('visitPage (react loop compatibility)', () => {
  const fakePool = { size: 0, configuredSize: 0 } as unknown as import('../../src/browser/pool.js').BrowserPool;

  it('returns pruned text on success', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200, page('Acme'), 'https://acme.test'));
    const text = await visitPage('https://acme.test', fakePool, 'what does the company do');
    expect(text).toContain('Acme builds software');
    expect(text.length).toBeLessThanOrEqual(4100);
  });

  it('returns error text on failure', async () => {
    const text = await visitPage('https://www.linkedin.com/in/someone', fakePool);
    expect(text).toContain('[Page not accessible: https://www.linkedin.com/in/someone]');
    expect(text).toContain('linkedin_blocked');
  });
});

describe('serper scrape fallback', () => {
  it('runs after Jina fails and returns Serper markdown', async () => {
    process.env['SERPER_API_KEY'] = 'serper-secret';
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockResolvedValueOnce(htmlResponse(403, CLOUDFLARE, 'https://walled.test'))
      .mockResolvedValueOnce(htmlResponse(403, 'forbidden', 'https://r.jina.ai/https://walled.test', 'text/plain'))
      .mockResolvedValueOnce(
        htmlResponse(200, JSON.stringify({ markdown: `# Walled Co\n\n${'Walled Co makes tractors for farms. '.repeat(10)}`, text: 'x' }), 'https://scrape.serper.dev', 'application/json')
      );
    const result = await fetchPage('https://walled.test');
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('serper');
    expect(result.tiers_tried).toEqual(['direct', 'jina', 'serper']);
    expect(result.markdown).toContain('Walled Co makes tractors');
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe('https://scrape.serper.dev');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-KEY']).toBe('serper-secret');
    expect(JSON.parse(init.body).url).toBe('https://walled.test');
  });

  it('is skipped without SERPER_API_KEY', async () => {
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockResolvedValueOnce(htmlResponse(403, CLOUDFLARE, 'https://walled2.test'))
      .mockResolvedValueOnce(htmlResponse(403, 'forbidden', 'https://r.jina.ai/https://walled2.test', 'text/plain'));
    const result = await fetchPage('https://walled2.test');
    expect(result.ok).toBe(false);
    expect(result.tiers_tried).toEqual(['direct', 'jina']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a Serper error status as a failed tier', async () => {
    process.env['SERPER_API_KEY'] = 'serper-secret';
    delete process.env['PROXY_URL_ROTATE'];
    fetchMock
      .mockResolvedValueOnce(htmlResponse(500, 'err', 'https://down.test'))
      .mockResolvedValueOnce(htmlResponse(502, 'err', 'https://r.jina.ai/https://down.test', 'text/plain'))
      .mockResolvedValueOnce(htmlResponse(400, '{"message":"bad"}', 'https://scrape.serper.dev', 'application/json'));
    const result = await fetchPage('https://down.test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('serper_http_400');
  });
});
