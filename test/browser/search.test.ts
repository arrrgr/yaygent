import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import nodeFetch from 'node-fetch';
import {
  search,
  sanitizeQueryValue,
  companyCore,
  serperRequestBody,
  parseSerperResponse,
  parseBingHtml,
  parseGoogleNewsRss,
  decodeBingRedirect,
  _clearSearchCache,
} from '../../src/browser/search.js';

const fetchMock = nodeFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown, url = 'https://google.serper.dev/search') {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

describe('sanitizeQueryValue', () => {
  it('strips quotes and "group of companies"', () => {
    expect(sanitizeQueryValue('"ALDIN" group of companies')).toBe('ALDIN');
  });

  it('strips punctuation and legal suffixes', () => {
    expect(sanitizeQueryValue('Stock Software, Inc.')).toBe('Stock Software');
    expect(sanitizeQueryValue('Acme Ltd')).toBe('Acme');
    expect(sanitizeQueryValue('Siemens Energy GmbH & Co. KG')).toBe('Siemens Energy');
  });

  it('turns an ampersand into "and" and never collapses an intercap one', () => {
    // `AT&T -> ATT` / `H&M -> HM` produced a quoted phrase that matches nothing.
    expect(sanitizeQueryValue('AT&T')).toBe('AT and T');
    expect(sanitizeQueryValue('H&M')).toBe('H and M');
    expect(sanitizeQueryValue('Procter & Gamble')).toBe('Procter and Gamble');
    expect(sanitizeQueryValue('AT&T')).not.toContain('&');
  });

  it('keeps a weak suffix when stripping it would leave one generic word', () => {
    expect(sanitizeQueryValue('The Carlyle Group')).toBe('The Carlyle Group');
    expect(sanitizeQueryValue('Co-op Group')).toBe('Co-op Group');
    // still stripped when a real multi-word core survives
    expect(sanitizeQueryValue('Nordic Capital Partners Group')).toBe('Nordic Capital Partners');
  });

  it('never strips a name down to nothing', () => {
    expect(sanitizeQueryValue('Group')).toBe('Group');
    expect(sanitizeQueryValue('Inc')).toBe('Inc');
    expect(sanitizeQueryValue('')).toBe('');
  });
});

describe('companyCore', () => {
  it('returns the short core name', () => {
    expect(companyCore('"ALDIN" group of companies', 'aldin.ru')).toBe('ALDIN');
    expect(companyCore('Stock Software, Inc.', 'stocksoftware.com')).toBe('Stock Software');
    expect(companyCore('AT&T', 'att.com')).toBe('AT and T');
  });

  it('does not collapse a two-word brand to one generic word', () => {
    // the prefix branch used to return `Bang` for a brand whose domain is bang-olufsen
    expect(companyCore('Bang & Olufsen', 'bang-olufsen.com')).toBe('Bang and Olufsen');
    // no domain to anchor on: the weak suffix stays rather than leaving one generic word
    expect(companyCore('The Carlyle Group')).toBe('The Carlyle Group');
  });

  it('anchors on the domain label when the name is longer than the domain', () => {
    expect(companyCore('Stripe Payments Europe Ltd', 'https://www.stripe.com')).toBe('Stripe');
    expect(companyCore('Big Data Consulting Partners LLC', 'bigdataconsulting.io')).toBe('Big Data Consulting');
  });

  it('falls back to the first three words without a domain', () => {
    expect(companyCore('Very Long Company Name Holdings Inc')).toBe('Very Long Company');
    expect(companyCore('', 'acme.com')).toBe('acme');
  });
});

describe('serperRequestBody', () => {
  it('maps recency to tbs and passes gl/hl/num', () => {
    expect(serperRequestBody('acme founder', { recency: '6m', gl: 'GB', hl: 'en', num: 5 })).toEqual({
      q: 'acme founder',
      gl: 'gb',
      hl: 'en',
      num: 5,
      tbs: 'qdr:m6',
    });
    expect(serperRequestBody('x', { recency: '1d' })['tbs']).toBe('qdr:d');
    expect(serperRequestBody('x', { recency: '1w' })['tbs']).toBe('qdr:w');
    expect(serperRequestBody('x', { recency: '1m' })['tbs']).toBe('qdr:m');
    expect(serperRequestBody('x', { recency: '1y' })['tbs']).toBe('qdr:y');
    expect(serperRequestBody('x', {})).not.toHaveProperty('tbs');
    expect(serperRequestBody('x', {})['num']).toBe(10);
  });
});

describe('parseSerperResponse', () => {
  it('passes organic date through and sets source/position', () => {
    const json = JSON.stringify({
      organic: [
        { title: 'A', link: 'https://a.com', snippet: 'sa', position: 1, date: 'Mar 3, 2026' },
        { title: 'B', link: 'https://b.com', snippet: 'sb', position: 2 },
      ],
    });
    const out = parseSerperResponse(json, 'web', 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'A', url: 'https://a.com', date: 'Mar 3, 2026', position: 1, source: 'serper' });
    expect(out[1].date).toBeUndefined();
  });

  it('reads news results with their date', () => {
    const json = JSON.stringify({
      news: [{ title: 'N', link: 'https://n.com/1', snippet: 'sn', date: '2 days ago', source: 'Reuters', position: 1 }],
    });
    const out = parseSerperResponse(json, 'news', 10);
    expect(out[0]).toMatchObject({ date: '2 days ago', source: 'serper_news' });
  });
});

describe('search() via Serper', () => {
  beforeEach(() => {
    _clearSearchCache();
    fetchMock.mockReset();
    process.env['SERPER_API_KEY'] = 'test-key';
  });
  afterEach(() => {
    delete process.env['SERPER_API_KEY'];
  });

  it('posts tbs and gl/hl to /search and hits /news for news type', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { organic: [{ title: 'T', link: 'https://t.com', snippet: 's', position: 1, date: 'Jan 1, 2026' }] })
    );
    const results = await search('acme news', { recency: '1m', gl: 'de', hl: 'de', num: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].date).toBe('Jan 1, 2026');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://google.serper.dev/search');
    expect(JSON.parse(init.body)).toEqual({ q: 'acme news', gl: 'de', hl: 'de', num: 3, tbs: 'qdr:m' });
    expect(init.headers['X-API-KEY']).toBe('test-key');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { news: [{ title: 'N', link: 'https://n.com', snippet: 's', date: '1 day ago' }] }, 'https://google.serper.dev/news')
    );
    const news = await search('acme funding', { type: 'news' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://google.serper.dev/news');
    expect(news[0]).toMatchObject({ source: 'serper_news', date: '1 day ago' });
  });

  it('serves repeated queries from the in-process cache', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] }));
    await search('Cached Query', { num: 5 });
    await search('cached   query', { num: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty result for an hour', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { organic: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] }));
    expect(await search('flaky query')).toHaveLength(0);
    expect(await search('flaky query')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses one num default for both call shapes so a query is not bought twice', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] }));
    const fakePool = { acquire: async () => ({}), release: () => {}, size: 0 } as unknown as import('../../src/browser/pool.js').BrowserPool;
    await search('same query');
    await search('same query', fakePool);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports the legacy (query, pool, maxResults) call shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { organic: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, link: `https://t${i}.com`, snippet: 's' })) })
    );
    const fakePool = { acquire: async () => ({}), release: () => {}, size: 0 } as unknown as import('../../src/browser/pool.js').BrowserPool;
    const results = await search('legacy', fakePool, 3);
    expect(results).toHaveLength(3);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)['num']).toBe(3);
  });
});

describe('parseBingHtml', () => {
  const fixture = `<!DOCTYPE html><html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://www.example.com/team" h="ID=SERP,1">Example Team - Leadership</a></h2>
<div class="b_caption"><p>Meet the leadership team of <strong>Example</strong>, founded by Jane Doe.</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?something">Bing owned</a></h2><div class="b_caption"><p>ignore</p></div></li>
<li class="b_algo"><h2><a href="https://www.linkedin.com/in/jane-doe">Jane Doe - CEO - Example | LinkedIn</a></h2>
<div class="b_caption"><p>Jane Doe is the CEO and co-founder of Example.</p></div></li>
</ol></body></html>`;

  it('extracts title, url and snippet from li.b_algo blocks and skips bing-owned urls', () => {
    const results = parseBingHtml(fixture, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Team - Leadership',
      url: 'https://www.example.com/team',
      snippet: 'Meet the leadership team of Example, founded by Jane Doe.',
      position: 1,
      source: 'bing_proxy',
    });
    expect(results[1].url).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('respects maxResults', () => {
    expect(parseBingHtml(fixture, 1)).toHaveLength(1);
  });

  // Shaped like a real SERP: Bing wraps organic results in /ck/a?...&u=a1<base64url>.
  const REAL_SHAPED = (() => {
    const wrap = (target: string) =>
      `https://www.bing.com/ck/a?!&amp;&amp;p=deadbeef&amp;u=a1${Buffer.from(target, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')}&amp;ntb=1`;
    return `<!DOCTYPE html><html><body><ol id="b_results">
<li class="b_algo"><h2><a href="${wrap('https://acme.io/team?ref=1')}" h="ID=SERP,5023.1">Acme - Our Team</a></h2>
<div class="b_caption"><p>Acme was founded by Jane Doe and Bob Roe in 2015.</p></div></li>
<li class="b_algo"><h2><a href="${wrap('https://www.linkedin.com/in/jane-doe')}">Jane Doe - Co-Founder - Acme</a></h2>
<div class="b_caption"><p>Co-Founder at Acme.</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?p=nou">No target</a></h2><div class="b_caption"><p>x</p></div></li>
</ol></body></html>`;
  })();

  it('decodes the bing.com/ck/a redirect instead of discarding the whole SERP', () => {
    const results = parseBingHtml(REAL_SHAPED, 10);
    expect(results.map((r) => r.url)).toEqual([
      'https://acme.io/team?ref=1',
      'https://www.linkedin.com/in/jane-doe',
    ]);
    expect(results[0].title).toBe('Acme - Our Team');
    expect(results.every((r) => !r.url.includes('bing.com'))).toBe(true);
  });

  it('decodeBingRedirect handles the a1 prefix, base64url and non-bing urls', () => {
    const payload = Buffer.from('https://example.com/a b', 'utf8').toString('base64url');
    expect(decodeBingRedirect(`https://www.bing.com/ck/a?u=a1${payload}`)).toBe('https://example.com/a%20b');
    expect(decodeBingRedirect('https://www.bing.com/ck/a?u=a1notbase64!!')).toBeNull();
    expect(decodeBingRedirect('https://www.bing.com/search?q=x')).toBeNull();
    expect(decodeBingRedirect('https://acme.io/team')).toBeNull();
  });
});

describe('parseGoogleNewsRss', () => {
  it('reads pubDate into date', () => {
    const xml = `<rss><channel><item><title>Acme raises $10M</title><link>https://news.example.com/acme</link>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><source url="https://news.example.com">Example News</source>
<description>&lt;a href="x"&gt;Acme raises $10M&lt;/a&gt;</description></item></channel></rss>`;
    const out = parseGoogleNewsRss(xml, 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Acme raises $10M',
      url: 'https://news.example.com/acme',
      date: 'Mon, 01 Sep 2026 10:00:00 GMT',
      source: 'google_news_rss',
    });
  });
});
