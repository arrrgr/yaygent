/**
 * Proxy URL helpers. Webshare rotating gateway user is `<user>-rotate`; a sticky
 * session is `<user>-<n>` (one exit IP per n). Search never uses proxies; only
 * target-site fetches do.
 */

export function rotatingProxyUrl(): string {
  return process.env['PROXY_URL_ROTATE']?.trim() || process.env['PROXY_URL']?.trim() || '';
}

/** Derive a sticky-session proxy URL from the rotating one by swapping `-rotate` for `-<n>`. */
export function stickyProxyUrl(n: number, base: string = rotatingProxyUrl()): string {
  if (!base) return '';
  try {
    const u = new URL(base);
    if (/-rotate$/i.test(u.username)) {
      u.username = u.username.replace(/-rotate$/i, `-${n}`);
    }
    return u.toString();
  } catch {
    return base;
  }
}

let stickyCounter = 0;
const STICKY_SESSIONS = 10;

/** Next sticky proxy URL, rotating n over 1..10. Empty string when no proxy is configured. */
export function nextStickyProxyUrl(): string {
  const base = rotatingProxyUrl();
  if (!base) return '';
  stickyCounter = (stickyCounter % STICKY_SESSIONS) + 1;
  return stickyProxyUrl(stickyCounter, base);
}

export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

/** Playwright wants credentials separate from the server string. */
export function toPlaywrightProxy(proxyUrl: string): PlaywrightProxy | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const proxy: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return { server: proxyUrl };
  }
}
