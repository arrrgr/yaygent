import { afterEach, describe, expect, it } from 'vitest';
import { nextStickyProxyUrl, rotatingProxyUrl, stickyProxyUrl, toPlaywrightProxy } from '../../src/browser/proxy.js';

afterEach(() => {
  delete process.env['PROXY_URL_ROTATE'];
  delete process.env['PROXY_URL'];
});

describe('proxy helpers', () => {
  it('derives a sticky session from the rotating username', () => {
    expect(stickyProxyUrl(3, 'http://abcd-rotate:secret@p.webshare.io:8080')).toBe('http://abcd-3:secret@p.webshare.io:8080/');
    expect(stickyProxyUrl(3, 'http://plain:secret@proxy.test:8080')).toBe('http://plain:secret@proxy.test:8080/');
    expect(stickyProxyUrl(3, '')).toBe('');
  });

  it('rotates n over 1..10 per call', () => {
    process.env['PROXY_URL_ROTATE'] = 'http://abcd-rotate:secret@p.webshare.io:80';
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(new URL(nextStickyProxyUrl()).username);
    expect(seen.size).toBe(10);
    for (const user of seen) expect(user).toMatch(/^abcd-(10|[1-9])$/);
  });

  it('prefers PROXY_URL_ROTATE and falls back to PROXY_URL', () => {
    process.env['PROXY_URL'] = 'http://a:b@old.test:1';
    expect(rotatingProxyUrl()).toBe('http://a:b@old.test:1');
    process.env['PROXY_URL_ROTATE'] = 'http://a-rotate:b@new.test:2';
    expect(rotatingProxyUrl()).toBe('http://a-rotate:b@new.test:2');
    expect(nextStickyProxyUrl()).toMatch(/^http:\/\/a-\d+:b@new\.test:2/);
  });

  it('splits credentials for Playwright', () => {
    expect(toPlaywrightProxy('http://us%40er:p%40ss@proxy.test:8080')).toEqual({
      server: 'http://proxy.test:8080',
      username: 'us@er',
      password: 'p@ss',
    });
    expect(toPlaywrightProxy('')).toBeUndefined();
  });
});
