/**
 * Which palette the app opens in.
 *
 * The read path is the part worth pinning. It runs before React mounts, on
 * every launch, against a value a user can corrupt by hand — and every way it
 * can go wrong (a private window, blocked site data, a stale value from an
 * older build) has to land on a working window rather than a thrown error.
 * A preference is not worth a launch.
 */
import { describe, expect, it } from 'vitest';
import { applyTheme, DEFAULT_THEME, otherTheme, readTheme, writeTheme } from '../src/renderer/src/theme.js';

/** A localStorage that behaves. */
function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  };
}

/** One that throws, the way a blocked or private context does. */
const hostile = {
  getItem: () => {
    throw new Error('site data is blocked');
  },
  setItem: () => {
    throw new Error('site data is blocked');
  },
};

describe('readTheme', () => {
  it('opens light on a machine that has never chosen', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(readTheme(storage())).toBe('light');
  });

  it('honours a stored choice', () => {
    expect(readTheme(storage({ 'archspace.theme': 'dark' }))).toBe('dark');
    expect(readTheme(storage({ 'archspace.theme': 'light' }))).toBe('light');
  });

  it('falls back rather than trusting a value it does not recognise', () => {
    // Hand-edited, or written by a future build that offered a third choice.
    expect(readTheme(storage({ 'archspace.theme': 'solarized' }))).toBe('light');
    expect(readTheme(storage({ 'archspace.theme': '' }))).toBe('light');
  });

  it('survives a storage that throws on read', () => {
    expect(readTheme(hostile)).toBe('light');
  });

  it('survives having no storage at all', () => {
    expect(readTheme(undefined)).toBe('light');
  });
});

describe('writeTheme', () => {
  it('remembers a choice under the key readTheme looks for', () => {
    const store = storage();
    writeTheme('dark', store);
    expect(readTheme(store)).toBe('dark');
  });

  it('swallows a storage that refuses the write', () => {
    // A preference that cannot be saved will not survive the session, which is
    // worth nothing to report and nothing to fix.
    expect(() => writeTheme('dark', hostile)).not.toThrow();
  });
});

describe('otherTheme', () => {
  it('is what the toggle switches to, and is its own inverse', () => {
    expect(otherTheme('light')).toBe('dark');
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme(otherTheme('light'))).toBe('light');
  });
});

describe('applyTheme', () => {
  it('sets the attribute CSS selects on, and the platform hint beside it', () => {
    // A tiny stand-in rather than jsdom: this suite runs under plain node by
    // design (vitest.config.ts), and the two writes are the whole contract.
    const root = { dataset: {} as Record<string, string>, style: {} as { colorScheme?: string } };

    applyTheme('dark', root as unknown as HTMLElement);
    expect(root.dataset['theme']).toBe('dark');
    // Without this the OS paints scrollbars and native controls for the wrong
    // scheme — dark widgets on a light page, which reads as a rendering bug.
    expect(root.style.colorScheme).toBe('dark');

    applyTheme('light', root as unknown as HTMLElement);
    expect(root.dataset['theme']).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});
