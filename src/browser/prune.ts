/**
 * HTML -> markdown conversion and question-focused pruning.
 * Pure functions, no network. Parse concurrency is the caller's job (parseSemaphore).
 */
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const DEFAULT_MAX_CHARS = 4_000;

const QUESTION_STOPWORDS = new Set([
  'the', 'this', 'that', 'what', 'does', 'who', 'for', 'and', 'with', 'from',
  'company', 'profile', 'target', 'are', 'its', 'their', 'about', 'page',
]);

const BOILERPLATE_LINE_TERMS = [
  'we value your privacy',
  'we use cookies',
  'this website uses cookies',
  'cookie policy',
  'cookie settings',
  'cookie preferences',
  'accept all cookies',
  'accept all',
  'reject all',
  'manage consent',
  'consent preferences',
  'necessary always active',
  'all rights reserved',
  'skip to content',
  'skip to main content',
  'subscribe to our newsletter',
  'sign up for our newsletter',
  'browser can display emojis',
  'search results in the future',
  'description is currently not available',
];

/**
 * Challenge detection needs a STRUCTURAL signal, not a keyword. A page that merely
 * mentions "captcha" or "datadome" in its copy is a real page; a 9KB Cloudflare
 * interstitial is not. Every marker below only appears on a block/challenge page.
 */
const CHALLENGE_MARKERS = [
  '/cdn-cgi/challenge-platform',
  '__cf_bm',
  'cf_chl_opt',
  '_cf_chl_',
  'cf-chl-bypass',
  'enable javascript and cookies to continue',
  'checking if the site connection is secure',
  'captcha-delivery.com',
  'px-captcha',
  'incapsula incident id',
  '_incapsula_resource',
  'errors.edgesuite.net',
  '/_sec/cp_challenge',
  '/sorry/index',
  'if you are not redirected',
];

/** Titles (or the first short lines of a Jina markdown render) that only challenge pages carry. */
const CHALLENGE_TITLE_PATTERN =
  /^[\s#>*_-]*(just a moment|attention required|access denied|access to this page has been denied|checking your browser|security check|verify you are human|verifying you are human|are you a robot|bot verification|human verification|pardon our interruption|you have been blocked|one more step)\b/i;

const CHALLENGE_STATUSES = new Set([403, 429, 503]);

function challengeTitles(body: string): string[] {
  const titles: string[] = [];
  const tagged = body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (tagged) titles.push(tagged[1]);
  // Jina hands us markdown, so there is no <title>: the challenge headline is one of
  // the first short lines instead.
  let seen = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= 80) titles.push(line);
    if (++seen >= 6) break;
  }
  return titles;
}

/**
 * True only for a page that is structurally a challenge/block interstitial:
 * a known challenge marker, a challenge title, or a challenge status with a tiny body.
 * There is deliberately NO body-size ceiling on the structural signals.
 */
/**
 * Language-independent interstitial signal: a large response whose visible text is tiny.
 * Challenge and redirect pages ship a big JS payload and a one-line localised message, so a
 * phrase list can never cover them (a Google /sorry page served to a Bangkok exit is in Thai).
 * Callers pass the RAW byte size and the EXTRACTED text length.
 */
export function looksLikeInterstitial(bytes: number, textChars: number): boolean {
  return bytes >= 20_000 && textChars < 600;
}

export function looksLikeChallenge(body: string, status: number): boolean {
  const text = body ?? '';
  if (!text) return CHALLENGE_STATUSES.has(status);
  const lower = text.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => lower.includes(marker))) return true;
  if (challengeTitles(text).some((title) => CHALLENGE_TITLE_PATTERN.test(title))) return true;
  if (CHALLENGE_STATUSES.has(status) && text.trim().length < 2_000) return true;
  return false;
}

// `header` is deliberately kept: landing pages put the hero line there.
const STRIP_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'nav', 'footer', 'aside', 'form'];
const STRIP_SELECTORS = [
  '[role="navigation"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[class*="gdpr" i]',
  '[id*="gdpr" i]',
  '.navbar',
  '.menu',
  '.breadcrumb',
  '.breadcrumbs',
  '.sidebar',
  '.site-header',
  '.site-footer',
];

function newTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  td.remove(['script', 'style', 'noscript', 'iframe']);
  td.remove((node) => node.nodeName.toLowerCase() === 'svg');
  return td;
}

function stripBoilerplateNodes(root: Document | Element): void {
  for (const tag of STRIP_TAGS) {
    root.querySelectorAll(tag).forEach((node) => node.remove());
  }
  for (const selector of STRIP_SELECTORS) {
    try {
      root.querySelectorAll(selector).forEach((node) => node.remove());
    } catch {
      // jsdom may not support a selector flag; skip it
    }
  }
}

function isBoilerplateLine(line: string): boolean {
  const lower = line.toLowerCase();
  return BOILERPLATE_LINE_TERMS.some((term) => lower.includes(term));
}

const MD_IMAGE_PATTERN = /!\[[^\][]*\]\(\s*[^)\s]*(?:\s+"[^"]*")?\s*\)/g;
// The text group excludes `[` so a link wrapping an image cannot swallow the image's own
// closing bracket and leave a mangled half-link behind.
const MD_LINK_PATTERN = /\[([^\][]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;

/** Noise cleaners that must never run over a link target, or they truncate the href. */
function scrubText(text: string): string {
  return text
    .replace(/\S+\.(?:avif|png|jpe?g|svg|webp|gif)(?:\?\S*)?/gi, '')
    .replace(/\bImage\s+\d+\b/gi, '');
}

/**
 * Keeps `[text](https://...)` intact. A stripped href means no url-typed field
 * (linkedin_person_url, crunchbase_url) can ever be extracted from a visited page.
 * Image links are dropped whole; relative, `data:` and `javascript:` targets collapse
 * to their anchor text.
 */
function cleanMarkdownLine(line: string): string {
  const withoutImages = line.replace(MD_IMAGE_PATTERN, '');
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  MD_LINK_PATTERN.lastIndex = 0;
  while ((match = MD_LINK_PATTERN.exec(withoutImages)) !== null) {
    out += scrubText(withoutImages.slice(last, match.index));
    last = match.index + match[0].length;
    const text = scrubText(match[1]).replace(/[ \t]+/g, ' ').trim();
    const href = match[2];
    // A link whose text was only an image carries nothing a reader or a model needs.
    if (!text) continue;
    if (/^https?:\/\//i.test(href)) out += `[${text}](${href})`;
    else out += text;
  }
  out += scrubText(withoutImages.slice(last));
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** Collapse whitespace and drop cookie/consent/nav-ish lines from markdown. */
export function cleanMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/\r/g, '')
    .split('\n')
    .map(cleanMarkdownLine)
    .filter((line) => line.length === 0 || !isBoilerplateLine(line));
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rewrite relative anchors to absolute so the kept link targets are usable evidence. */
function absolutizeHrefs(root: Element): void {
  root.querySelectorAll('a[href]').forEach((node) => {
    try {
      const resolved = (node as HTMLAnchorElement).href;
      if (resolved && /^https?:/i.test(resolved)) node.setAttribute('href', resolved);
    } catch {
      // leave the raw href alone
    }
  });
}

/** Readability -> turndown; falls back to the cleaned body when Readability keeps too little. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  if (!html || !html.trim()) return '';
  const td = newTurndown();
  let bodyMarkdown = '';
  let readableMarkdown = '';

  try {
    // ONE JSDOM tree per page. The body candidate is a detached clone inside the same
    // document, not a second JSDOM: that doubled the memory the parse cap is sized for.
    const dom = new JSDOM(html, { url: baseUrl });
    const document = dom.window.document;

    // Body candidate first (Readability mutates the DOM).
    const bodyClone = document.body?.cloneNode(true) as HTMLElement | null;
    if (bodyClone) {
      stripBoilerplateNodes(bodyClone);
      absolutizeHrefs(bodyClone);
      bodyMarkdown = cleanMarkdown(td.turndown(bodyClone.innerHTML));
    }

    try {
      const article = new Readability(document).parse();
      if (article?.content) {
        readableMarkdown = cleanMarkdown(td.turndown(article.content));
      }
    } catch {
      readableMarkdown = '';
    }
  } catch {
    // Unparseable HTML: strip tags with regex as a last resort.
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    return cleanMarkdown(text.replace(/\s+/g, ' '));
  }

  if (readableMarkdown.length >= 500 && readableMarkdown.length >= bodyMarkdown.length * 0.3) {
    return readableMarkdown;
  }
  return bodyMarkdown || readableMarkdown;
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function questionKeywords(question: string): Set<string> {
  const terms = new Set(
    question
      .split(/[^a-zA-Z0-9]+/)
      .map(normalizeToken)
      .filter((term) => term.length >= 3 && !QUESTION_STOPWORDS.has(term))
  );
  const lower = question.toLowerCase();
  const add = (words: string[]) => words.forEach((word) => terms.add(word));

  if (/\b(what|do|does|description|describe)\b/.test(lower)) {
    add(['platform', 'product', 'products', 'service', 'services', 'solution', 'solutions', 'specializes', 'provides', 'helps', 'software', 'technology', 'mission']);
  }
  if (/\b(customer|customers|icp|ideal|serve|serves)\b/.test(lower)) {
    add(['customer', 'customers', 'client', 'clients', 'brands', 'businesses', 'companies', 'enterprise', 'enterprises', 'industries', 'teams', 'organizations', 'market', 'manufacturers']);
  }
  if (/\b(founder|founders|founded|ceo|team|leadership|executive)\b/.test(lower)) {
    add(['founder', 'founders', 'founded', 'cofounder', 'ceo', 'cto', 'coo', 'president', 'chief', 'team', 'leadership', 'started']);
  }
  if (/\b(news|funding|launch|partnership|announced|acquisition)\b/.test(lower)) {
    add(['news', 'press', 'blog', 'announced', 'announces', 'launch', 'launched', 'funding', 'raised', 'partner', 'partnership', 'appoints', 'appointed', 'acquired', '2026', '2025']);
  }
  return terms;
}

interface Section {
  index: number;
  heading: string;
  lines: string[];
  text: string;
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { index: 0, heading: '', lines: [], text: '' };
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      if (current.heading || current.lines.some((l) => l.trim())) sections.push(current);
      current = { index: sections.length, heading: line, lines: [], text: '' };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading || current.lines.some((l) => l.trim())) sections.push(current);
  for (const section of sections) {
    section.text = [section.heading, ...section.lines].join('\n').trim();
  }
  return sections;
}

function takeTop(markdown: string, maxChars: number): string {
  const text = markdown.trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const head = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${head.trimEnd()}\n\n[...truncated]`;
}

function countMatches(text: string, terms: Set<string>): { distinct: number; total: number } {
  const lower = text.toLowerCase();
  let distinct = 0;
  let total = 0;
  for (const term of terms) {
    if (!term) continue;
    let idx = lower.indexOf(term);
    if (idx === -1) continue;
    distinct += 1;
    while (idx !== -1 && total < 50) {
      total += 1;
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  return { distinct, total };
}

function shrinkSection(section: Section, terms: Set<string>, limit: number): string {
  if (section.text.length <= limit) return section.text;
  const kept: string[] = [];
  let used = section.heading.length;
  if (section.heading) kept.push(section.heading);
  section.lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const matches = i < 3 || countMatches(trimmed, terms).distinct > 0;
    if (!matches) return;
    if (used + trimmed.length + 1 > limit) return;
    kept.push(trimmed);
    used += trimmed.length + 1;
  });
  return kept.join('\n');
}

/**
 * Heading-section scoring against the question. Short lines are kept (no minimum
 * line length). Without a question, returns the top of the document.
 */
export function pruneForQuestion(markdown: string, question?: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const cleaned = cleanMarkdown(markdown ?? '');
  if (!question || !question.trim() || cleaned.length <= maxChars) {
    return takeTop(cleaned, maxChars);
  }

  const terms = questionKeywords(question);
  const sections = splitSections(cleaned);
  if (sections.length === 0) return takeTop(cleaned, maxChars);

  // The lead section (title + hero) always survives: short hero lines are often the answer.
  const lead = sections[0];
  const scored = sections
    .slice(1)
    .map((section) => {
      const body = countMatches(section.text, terms);
      const heading = countMatches(section.heading, terms);
      const positionBoost = section.index < 3 ? 0.5 : 0;
      const score = body.distinct * 2 + Math.min(body.total, 10) * 0.2 + heading.distinct * 2 + positionBoost;
      return { section, score, matched: body.distinct > 0 || heading.distinct > 0 };
    })
    .filter((item) => item.matched)
    .sort((a, b) => b.score - a.score || a.section.index - b.section.index);

  if (scored.length === 0) {
    return takeTop(cleaned, maxChars);
  }

  const perSectionCap = Math.max(600, Math.floor(maxChars / 2));
  const chosen: Array<{ index: number; text: string }> = [];
  let used = 0;
  const leadText = shrinkSection(lead, terms, Math.max(300, Math.floor(maxChars / 3)));
  if (leadText) {
    chosen.push({ index: lead.index, text: leadText });
    used += leadText.length + 2;
  }
  let addedScored = false;
  for (const item of scored) {
    const text = shrinkSection(item.section, terms, perSectionCap);
    if (!text) continue;
    const cost = text.length + 2;
    if (used + cost > maxChars) {
      const room = maxChars - used;
      if (!addedScored && room > 200) {
        chosen.push({ index: item.section.index, text: takeTop(text, room) });
        used = maxChars;
        addedScored = true;
      }
      continue;
    }
    addedScored = true;
    chosen.push({ index: item.section.index, text });
    used += cost;
    if (used >= maxChars * 0.95) break;
  }

  chosen.sort((a, b) => a.index - b.index);
  return takeTop(chosen.map((c) => c.text).join('\n\n'), maxChars);
}
