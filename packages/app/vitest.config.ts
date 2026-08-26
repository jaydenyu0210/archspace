/**
 * Vitest for the Electron app (ADR-0013).
 *
 * Scoped deliberately narrowly. Most of this package is either Electron main —
 * which needs a real Electron runtime, not a mock of one — or React components,
 * whose behaviour ADR-0013 covers through the headless CLI rather than a DOM
 * simulator. What IS worth unit-testing is the pure logic that decides what the
 * UI claims, because that is where a wrong answer becomes a lie on screen.
 *
 * `environment: 'node'` and no jsdom: everything included below must be
 * importable without a DOM. That is a constraint on what may live in these
 * files, not a limitation of the runner — it is what keeps this fast and what
 * forced `drift.ts` out of `store.ts`, which imports @xyflow/react for value.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
