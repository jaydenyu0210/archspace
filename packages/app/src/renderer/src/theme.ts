/**
 * Which palette the app wears, and where that is remembered.
 *
 * Archspace was dark-only: one `:root` block of graphite-blue tokens, a body
 * background hard-coded in `index.html`, and a header comment describing a
 * "digital drafting table". The dark palette still exists and is unchanged —
 * what changed is that it is no longer the only one, and no longer the
 * default. Drafting on paper is the older metaphor and the one most people
 * expect a document tool to open in.
 *
 * **The OS preference is deliberately not consulted.** `prefers-color-scheme`
 * would be the reflex, but it makes the default unpredictable: the same app on
 * two machines would open in two skins, and "why is mine dark" has no answer
 * on screen. A stated default plus a visible toggle is a smaller promise and a
 * keepable one. If following the system is wanted later it belongs as a third
 * choice — `light | dark | system` — not as a hidden override of this one.
 *
 * Pure and separate from any component, like `panel-height.ts` next door, so
 * the read path is testable: a stored value that no longer parses must fall
 * back rather than throw, because a corrupt preference should cost a colour
 * scheme and never a launch.
 */

export type Theme = 'light' | 'dark';

/** Paper, not graphite. Stated once here and read by everything else. */
export const DEFAULT_THEME: Theme = 'light';

const STORAGE_KEY = 'archspace.theme';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/**
 * The theme to open in.
 *
 * `localStorage` throws rather than returns null in a few real situations — a
 * window with site data blocked, a private context — so the read is guarded.
 * Every failure lands on the same answer as a first launch, which is the only
 * answer that is always safe.
 */
export function readTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Theme {
  if (storage === undefined) return DEFAULT_THEME;
  try {
    const stored = storage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remember a choice. A storage that refuses the write is not an error here. */
export function writeTheme(theme: Theme, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(STORAGE_KEY, theme);
  } catch {
    // A preference that could not be saved is a preference that will not
    // survive the session. That is worth nothing to report and nothing to fix.
  }
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light';
}

/**
 * Put the theme where CSS can see it.
 *
 * `data-theme` on the root element, because that is the one selector that can
 * beat `:root` without `!important` and is visible to a smoke test in a live
 * window. The `color-scheme` property goes with it so the platform's own
 * widgets — scrollbars, form controls, the window chrome behind a native
 * dialog — change with the app rather than staying dark against a light page.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  root.dataset['theme'] = theme;
  root.style.colorScheme = theme;
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Accessing the accessor itself can throw when site data is blocked.
    return undefined;
  }
}
