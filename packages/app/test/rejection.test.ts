/**
 * The advice attached to a refused run (ADR-0008).
 *
 * The case that matters is the out-of-the-box one: a fresh install opens the
 * bundled example, whose review node comes from the bundled plugin, and that
 * plugin is `needs-consent` until a human decides. Pressing Run then produced
 * a message that was true and useless — "unknown type
 * aec.review.code_compliance" — with nothing on screen connecting it to the
 * Settings screen two clicks away.
 *
 * Equally important is what it must NOT say. A hint that is sometimes wrong
 * sends people to a screen where nothing they do helps, which is worse than
 * the bare engine message, so most of these tests are about staying quiet.
 */
import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '@archspace/engine';
import type { InstalledPluginInfo } from '@archspace/plugin-host';
import { explainRejection, type TypedNode } from '../src/renderer/src/rejection';

const node = (id: string, typeId: string): TypedNode => ({ id, data: { typeId } });

const unknownType = (nodeId: string, typeId: string): ValidationIssue => ({
  severity: 'error',
  code: 'unknown-type',
  message: `node "${nodeId}" has unknown type "${typeId}"`,
  nodeId,
});

function plugin(over: Partial<InstalledPluginInfo> = {}): InstalledPluginInfo {
  return {
    id: 'aec-review',
    dir: '/plugins/aec-review',
    source: 'bundled',
    state: 'needs-consent',
    grantedPermissions: [],
    nodeTypes: [],
    containsNativeCode: false,
    restarts: 0,
    manifest: {
      name: 'aec-review',
      version: '0.1.0',
      namespace: 'aec.review',
      displayName: 'AEC Discipline Reviews',
      engineApi: 1,
      entry: 'dist/index.js',
      permissions: [],
    },
    ...over,
  } as InstalledPluginInfo;
}

const NODES = [node('n1', 'aec.review.code_compliance')];
const ISSUES = [unknownType('n1', 'aec.review.code_compliance')];

describe('explainRejection', () => {
  it('names the plugin and the screen when it is merely unconsented', () => {
    const message = explainRejection(ISSUES, NODES, [plugin()]);

    expect(message).toContain('has unknown type "aec.review.code_compliance"');
    expect(message).toContain('AEC Discipline Reviews');
    expect(message).toContain('Settings → Plugins');
  });

  it('distinguishes switched-off from never-decided', () => {
    const disabled = explainRejection(ISSUES, NODES, [plugin({ state: 'disabled' })]);
    expect(disabled).toContain('switched off');
    expect(disabled).not.toContain('has not been enabled yet');
  });

  it('passes a load failure through, because the fix is not a toggle', () => {
    const message = explainRejection(ISSUES, NODES, [
      plugin({ state: 'failed', error: 'entry not found' }),
    ]);
    expect(message).toContain('failed to load');
    expect(message).toContain('entry not found');
  });

  it('says nothing extra when the plugin is loaded', () => {
    // Then the missing type is not this plugin's fault, and blaming it would
    // send the reader to a screen where everything already looks correct.
    const message = explainRejection(ISSUES, NODES, [plugin({ state: 'loaded' })]);
    expect(message).toBe('node "n1" has unknown type "aec.review.code_compliance"');
  });

  it('says nothing extra when no installed plugin owns that namespace', () => {
    const message = explainRejection(ISSUES, NODES, [
      plugin({ manifest: { ...plugin().manifest, namespace: 'other.ns' } }),
    ]);
    expect(message).toBe('node "n1" has unknown type "aec.review.code_compliance"');
  });

  it('does not match a namespace that is merely a string prefix', () => {
    // "aec.reviewer.x" is not inside the "aec.review" namespace, and matching
    // it would name a plugin that genuinely cannot supply the type.
    const nodes = [node('n1', 'aec.reviewer.x')];
    const issues = [unknownType('n1', 'aec.reviewer.x')];
    expect(explainRejection(issues, nodes, [plugin()])).toBe('node "n1" has unknown type "aec.reviewer.x"');
  });

  it('leaves other validation failures alone', () => {
    const cycle: ValidationIssue = { severity: 'error', code: 'cycle', message: 'graph has a cycle' };
    expect(explainRejection([cycle], NODES, [plugin()])).toBe('graph has a cycle');
  });

  it('falls back rather than throwing on an empty verdict', () => {
    expect(explainRejection([], [], [])).toBe('validation failed');
  });
});

/**
 * A plugin's own error text is interpolated mid-sentence, and the sentence
 * after it is not optional — so "failed to load: boom See Settings → Plugins."
 * was what a user actually read. Adding a full stop unconditionally is the
 * other half of the bug: plenty of error strings already end in one.
 */
describe('a plugin error quoted inside a sentence', () => {
  const failedWith = (error: string | undefined): string =>
    explainRejection(
      [unknownType('n_a', 'aec.review.zoning')],
      [node('n_a', 'aec.review.zoning')],
      [plugin({ state: 'failed', nodeTypes: ['aec.review.zoning'], ...(error !== undefined ? { error } : {}) })],
    );

  it('ends the quoted error before the next sentence', () => {
    const message = failedWith('boom');
    expect(message).toContain('failed to load: boom. See Settings');
    expect(message).not.toContain('boom See');
  });

  it('does not double the full stop when the error already has one', () => {
    expect(failedWith('boom.')).toContain('failed to load: boom. See Settings');
    expect(failedWith('boom.')).not.toContain('boom.. See');
  });

  it('handles the other terminators, and trailing whitespace', () => {
    expect(failedWith('what?')).toContain('what? See Settings');
    expect(failedWith('no!')).toContain('no! See Settings');
    expect(failedWith('boom\n')).toContain('boom. See Settings');
  });

  it('still reads correctly when there is no error text at all', () => {
    expect(failedWith(undefined)).toContain('failed to load. See Settings');
  });
});
