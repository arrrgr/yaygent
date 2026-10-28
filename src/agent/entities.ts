/**
 * Entity model for list outputs (founders, executives): merge across cycles,
 * per-entity locks. Name normalisation lives in names.ts - one normaliser for
 * the whole engine (review 1.10).
 */

import { betterDisplay, cleanDisplayName, namesMatch, normalizeName } from './names.js';
import type { Verdict } from './judge.js';

export { namesMatch, normalizeName } from './names.js';

export interface EntityLock {
  value: unknown;
  quote: string;
  source_url: string;
  conf: number;
  verified_by?: string;
  cycle: number;
}

export interface EntityState {
  /** normalised key-field value */
  key: string;
  /** best display form of the key field seen so far */
  display: string;
  locked: Record<string, EntityLock>;
  /** judged-but-unlocked or rejected candidates, per field */
  candidates: Record<string, Verdict[]>;
  /** strategy indexes already fanned out to this entity */
  tried: Set<number>;
}

export function findEntity(entities: EntityState[], name: string): EntityState | undefined {
  return entities.find((e) => namesMatch(e.display, name));
}

/**
 * Merge an entity by name. Returns the existing match or a new entity;
 * returns undefined when the cap is reached and the name is new.
 */
export function mergeEntity(entities: EntityState[], name: string, max: number): EntityState | undefined {
  const existing = findEntity(entities, name);
  if (existing) {
    existing.display = betterDisplay(existing.display, name);
    existing.key = normalizeName(existing.display);
    return existing;
  }
  if (entities.length >= max) return undefined;
  const created = newEntityState(name);
  entities.push(created);
  return created;
}

export function newEntityState(name: string): EntityState {
  const display = cleanDisplayName(name);
  return { key: normalizeName(display), display, locked: {}, candidates: {}, tried: new Set() };
}

export function lockedValues(e: EntityState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.locked)) out[k] = String(v.value);
  return out;
}

export function entityMissing(e: EntityState, requiredFields: string[]): string[] {
  return requiredFields.filter((f) => !(f in e.locked));
}
