import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateNodeId } from '../src/index';

describe('generateNodeId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches ^n_[a-z2-7]{6}$', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateNodeId()).toMatch(/^n_[a-z2-7]{6}$/);
    }
  });

  it('respects the taken set', () => {
    // First 6 draws force "n_aaaaaa" (taken), the next 6 force "n_777777".
    const seq = [...Array<number>(6).fill(0), ...Array<number>(6).fill(0.9999)];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => seq[i++] ?? 0.5);
    const id = generateNodeId(['n_aaaaaa']);
    expect(id).toBe('n_777777');
  });

  it('accepts any iterable for taken', () => {
    const taken = new Set(['n_zzzzzz']);
    const id = generateNodeId(taken);
    expect(id).toMatch(/^n_[a-z2-7]{6}$/);
    expect(taken.has(id)).toBe(false);
  });
});
