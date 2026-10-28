import { afterEach, describe, expect, it, vi } from 'vitest';
import { LruCache } from '../../src/browser/lru.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('LruCache', () => {
  it('evicts the least recently used entry past the cap', () => {
    const lru = new LruCache<number>(2, 60_000);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.size).toBe(2);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
  });

  it('a read moves an entry to the tail, so it survives the next eviction', () => {
    const lru = new LruCache<number>(2, 60_000);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
  });

  it('re-setting a key replaces the value and does not grow the map', () => {
    const lru = new LruCache<number>(3, 60_000);
    lru.set('a', 1);
    lru.set('a', 2);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBe(2);
  });

  it('expires an entry once its TTL passes', () => {
    vi.useFakeTimers();
    const lru = new LruCache<string>(10, 1_000);
    lru.set('k', 'v');
    vi.advanceTimersByTime(999);
    expect(lru.get('k')).toBe('v');
    vi.advanceTimersByTime(2);
    expect(lru.get('k')).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it('clear empties the cache', () => {
    const lru = new LruCache<number>(5, 60_000);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get('a')).toBeUndefined();
  });
});
