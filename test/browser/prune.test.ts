import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, pruneForQuestion, looksLikeChallenge, cleanMarkdown } from '../../src/browser/prune.js';

const GOOGLE_REDIRECT_PAGE = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/sorry/index"></head>
<body><div>Please click <a href="/sorry/index">here</a> if you are not redirected within a few seconds.</div></body></html>`;

const CLOUDFLARE_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head>
<body class="no-js"><div class="main-wrapper"><h1>www.example.com</h1><p>Checking if the site connection is secure</p>
<noscript><div id="challenge-error-title">Enable JavaScript and cookies to continue</div></noscript></div></body></html>`;

const REAL_PAGE = `<!doctype html><html><head><title>Acme</title></head><body>
<nav><a href="/">Home</a><a href="/about-us">About</a><a href="/pricing">Pricing</a></nav>
<header><h1>Payments infrastructure for the internet</h1><p>Acme helps startups accept payments.</p></header>
<main><h2>Products</h2><p>We sell billing software to SaaS companies in Europe and the US. Our platform provides invoicing, tax and revenue recognition.</p>
<h2>Customers</h2><p>Trusted by 4,000 brands including large enterprises and small businesses.</p></main>
<div class="cookie-banner">We use cookies. Accept all</div>
<footer>All rights reserved. Acme Inc.</footer></body></html>`;

describe('looksLikeChallenge', () => {
  it('flags the Google "not redirected" interstitial', () => {
    expect(looksLikeChallenge(GOOGLE_REDIRECT_PAGE, 200)).toBe(true);
  });

  it('flags a Cloudflare "Just a moment" page', () => {
    expect(looksLikeChallenge(CLOUDFLARE_PAGE, 503)).toBe(true);
    expect(looksLikeChallenge(CLOUDFLARE_PAGE, 200)).toBe(true);
  });

  it('flags a 403 with a tiny body', () => {
    expect(looksLikeChallenge('<html><body>Forbidden</body></html>', 403)).toBe(true);
  });

  it('does not flag a real 200 page', () => {
    expect(looksLikeChallenge(REAL_PAGE, 200)).toBe(false);
  });

  // The old rule was "any anti-bot keyword in a body under 8k". It both over-fired (every
  // security vendor in a lead list) and under-fired (a 9KB Cloudflare interstitial).
  it('does not flag a page that merely mentions captcha or datadome, at any size', () => {
    const big = `<html><body>${'<p>We sell captcha solving tools.</p>'.repeat(400)}</body></html>`;
    expect(big.length).toBeGreaterThan(8000);
    expect(looksLikeChallenge(big, 200)).toBe(false);

    const small = '<html><head><title>DataDome</title></head><body><h1>DataDome</h1><p>We stop bots. Our bot detection blocks captcha farms and scrapers.</p></body></html>';
    expect(small.length).toBeLessThan(8000);
    expect(looksLikeChallenge(small, 200)).toBe(false);

    const noscript = '<html><body><noscript>Please enable JavaScript to use this site.</noscript><p>Acme builds payroll software.</p></body></html>';
    expect(looksLikeChallenge(noscript, 200)).toBe(false);

    const vendor = '<html><head><title>PerimeterX vs Incapsula - a comparison</title></head><body><p>Access denied errors and request blocked pages explained.</p></body></html>';
    expect(looksLikeChallenge(vendor, 200)).toBe(false);
  });

  it('flags a challenge page well over 8KB', () => {
    const padded = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>${'<div>x</div>'.repeat(900)}</body></html>`;
    expect(padded.length).toBeGreaterThan(9000);
    expect(looksLikeChallenge(padded, 200)).toBe(true);

    const cfScript = `<html><head><title>acme.com</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></head><body>${'<p>padding</p>'.repeat(900)}</body></html>`;
    expect(cfScript.length).toBeGreaterThan(8000);
    expect(looksLikeChallenge(cfScript, 200)).toBe(true);
  });

  it('flags a challenge rendered to markdown by Jina (no html tags at all)', () => {
    expect(looksLikeChallenge('Just a moment...\n\nEnable JavaScript and cookies to continue', 200)).toBe(true);
    expect(looksLikeChallenge('# Access Denied\n\nYou do not have permission to access this page.', 200)).toBe(true);
  });
});

describe('htmlToMarkdown', () => {
  it('keeps hero copy and drops nav, footer and cookie banners', () => {
    const md = htmlToMarkdown(REAL_PAGE, 'https://acme.com');
    expect(md).toContain('Payments infrastructure for the internet');
    expect(md).toContain('billing software');
    expect(md).not.toContain('Pricing');
    expect(md).not.toContain('All rights reserved');
    expect(md).not.toContain('Accept all');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('', 'https://acme.com')).toBe('');
  });

  // The single worst defect in this layer: cleanMarkdownLine rewrote [text](url) to text,
  // so no url-typed field could ever be extracted from a page we fetched.
  it('keeps link targets, including LinkedIn profile links on a team page', () => {
    const team = `<!doctype html><html><head><title>Team</title></head><body><main>
<h1>Our team</h1>
<p>Acme builds billing software for SaaS companies that need reliable revenue tooling and invoicing.</p>
<ul>
<li><a href="https://www.linkedin.com/in/jane-doe">Jane Doe</a> - Co-Founder and CEO of Acme, previously at a large payments company.</li>
<li><a href="/about/bob">Bob Roe</a> - CTO, joined in 2016 after a decade building infrastructure.</li>
</ul>
<p>Read more on <a href="https://www.crunchbase.com/organization/acme">Crunchbase</a>.</p>
<p><a href="https://acme.com/logo.png"><img src="https://acme.com/logo.png" alt="Acme logo"></a></p>
</main></body></html>`;
    const md = htmlToMarkdown(team, 'https://acme.com/team');
    expect(md).toContain('https://www.linkedin.com/in/jane-doe');
    expect(md).toContain('[Jane Doe](https://www.linkedin.com/in/jane-doe)');
    expect(md).toContain('https://www.crunchbase.com/organization/acme');
    // relative hrefs are resolved against the page, not dropped
    expect(md).toContain('https://acme.com/about/bob');
    // images never survive as markdown image syntax
    expect(md).not.toContain('![');
  });

  it('drops data: and javascript: link targets but keeps their text', () => {
    const md = cleanMarkdown('[Click](javascript:void(0)) and [Blob](data:text/html;base64,AAAA) and [Real](https://acme.com/x)');
    expect(md).toContain('Click');
    expect(md).toContain('Blob');
    expect(md).not.toContain('javascript:');
    expect(md).not.toContain('data:text/html');
    expect(md).toContain('[Real](https://acme.com/x)');
  });

  it('pruneForQuestion keeps the link targets in what it returns', () => {
    const md = `# Acme\n\nAcme builds software.\n\n## Leadership\n\n[Jane Doe](https://www.linkedin.com/in/jane-doe) founded Acme in 2015 and serves as CEO.\n\n## Pricing\n\n${'Plans start at $10. '.repeat(120)}`;
    const out = pruneForQuestion(md, 'who founded the company', 800);
    expect(out).toContain('https://www.linkedin.com/in/jane-doe');
  });
});

describe('pruneForQuestion', () => {
  it('keeps a 39-char hero line when answering "what does the company do"', () => {
    const hero = 'Payments infrastructure for the internet';
    expect(hero.length).toBeLessThanOrEqual(40);
    const md = `# Acme\n\n${hero}\n\n## Blog\n\n${'Lorem ipsum dolor sit amet consectetur. '.repeat(300)}\n\n## Products\n\nWe provide billing software.`;
    const out = pruneForQuestion(md, 'what does the company do', 1500);
    expect(out).toContain(hero);
    expect(out.length).toBeLessThanOrEqual(1500 + 20);
  });

  it('without a question takes the top of the document and keeps headings', () => {
    const md = `# Title\n\nShort line.\n\n## Section two\n\n${'x'.repeat(5000)}`;
    const out = pruneForQuestion(md, undefined, 200);
    expect(out.startsWith('# Title')).toBe(true);
    expect(out).toContain('Short line.');
    expect(out.length).toBeLessThanOrEqual(230);
  });

  it('returns the whole document when it fits', () => {
    const md = '# A\n\nhello world';
    expect(pruneForQuestion(md, 'who founded the company')).toBe(md);
  });

  it('prefers sections that match the question', () => {
    const md = `# Home\n\nWelcome.\n\n## Careers\n\n${'Join our team of engineers. '.repeat(120)}\n\n## Leadership\n\nJane Doe founded Acme in 2015 and serves as CEO.\n\n## Pricing\n\n${'Plans start at $10. '.repeat(120)}`;
    const out = pruneForQuestion(md, 'who founded the company', 800);
    expect(out).toContain('Jane Doe founded Acme');
    expect(out).not.toContain('Plans start at $10');
  });
});

import { looksLikeInterstitial } from '../../src/browser/prune.js';

describe('looksLikeInterstitial (language-independent)', () => {
  it('flags a big payload with almost no visible text', () => {
    // real shape: Google /sorry served to a Bangkok exit, 92,887 bytes -> 221 chars of Thai
    expect(looksLikeInterstitial(92_887, 221)).toBe(true);
  });

  it('does not flag a small page that is simply short', () => {
    expect(looksLikeInterstitial(1_300, 131)).toBe(false);
  });

  it('does not flag a real page with real content', () => {
    expect(looksLikeInterstitial(411_420, 8_971)).toBe(false);
  });
});
