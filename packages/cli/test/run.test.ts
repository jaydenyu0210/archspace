/**
 * `archspace run` — the headless runner, driven as a process.
 *
 * ADR-0013 §1 makes this command the integration harness for everything below
 * the Electron shell, which means the thing under test here is not a function
 * but a *transcript and an exit code*: what CI branches on, and what an
 * operator reads when a colleague's workflow will not run on their machine.
 *
 * The invariant worth the most is that failure is honest. A validation error
 * has to stop the run — not warn and proceed, not run the nodes that happened
 * to be fine. A partial run is the worst available outcome: the exit code says
 * something failed, the transcript shows nodes completing, and any artifacts
 * written along the way are a half-answer that looks like an answer. So the
 * failing cases below assert the absence of a run as carefully as they assert
 * the message, and a passing case runs immediately before them so that
 * "nothing ran" cannot pass by nothing being runnable.
 *
 * The child is a real `node` process over the real `src/index.ts`, with a temp
 * `--config-dir` and a scrubbed `ARCHSPACE_*` environment (helpers.ts). It
 * never reaches the network: the fixtures use `aec.*` core nodes, which are
 * pure CPU, and the one MCP reference is deliberately unbound.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { coreNodeTypes } from '@archspace/nodes-core';
import { cleanupTempDirs, runCli, tempDir, workflowYaml } from './helpers.js';

afterEach(cleanupTempDirs);

/** A node that exists, is pure, and needs neither AI nor MCP to produce output. */
const REAL_NODE = 'aec.project_brief';
const GHOST_NODE = 'aec.no_such_node';

async function fixture(file: string, contents: string): Promise<{ dir: string; path: string }> {
  const dir = await tempDir({ [file]: contents });
  return { dir, path: join(dir, file) };
}

describe('archspace run — a workflow this machine can run', () => {
  it('runs it to completion and exits 0', async () => {
    // The control for every "nothing ran" assertion below, and the smallest
    // possible end-to-end proof that the CLI's registry, the document parser
    // and the engine agree: a real node type, executed, reported, exit 0.
    const { dir, path } = await fixture(
      'one-brief.archspace.yaml',
      workflowYaml('One Brief', [{ id: 'brief', type: REAL_NODE }]),
    );

    const result = await runCli(['run', path, '--config-dir', dir]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('Running One Brief (1 nodes)');
    expect(result.output).toContain('run started');
    expect(result.output).toContain('complete      brief');
    expect(result.output).toContain('run finished  succeeded');
  });
});

describe('archspace run — a workflow this machine cannot run', () => {
  it('names the offending node and its type, and starts no run at all', async () => {
    // The node that *would* have run sits alongside the ghost on purpose: with
    // no edge between them, a runner that validated leniently would happily
    // execute `brief` and report a partial success. The absence assertions are
    // the point of this test; the message assertions only make the failure
    // diagnosable.
    const { dir, path } = await fixture(
      'ghost.archspace.yaml',
      workflowYaml('Ghost Node', [
        { id: 'brief', type: REAL_NODE },
        { id: 'ghost', type: GHOST_NODE },
      ]),
    );

    const result = await runCli(['run', path, '--config-dir', dir]);

    expect(result.code).toBe(1);
    // The node id, the type and the engine's code: the id is what the operator
    // has to find in their file, the type is what they have to install or
    // rename, and the code is what a script greps for.
    expect(result.output).toContain('unknown-type');
    expect(result.output).toContain('"ghost"');
    expect(result.output).toContain(GHOST_NODE);
    expect(result.output).toContain('Validation failed — not running.');
    // Nothing started, so nothing can have half-finished.
    expect(result.output).not.toContain('run started');
    expect(result.output).not.toContain('Running Ghost Node');
    expect(result.output).not.toContain('complete      brief');
    expect(result.output).not.toContain('run finished');
  });

  it('reports a document it cannot parse as invalid, and starts no run', async () => {
    // Structural damage, as opposed to a workflow that parses and fails to
    // validate — a different branch of `cmdRun`, with the same obligation.
    const { dir, path } = await fixture('broken.archspace.yaml', 'archspace: 1\nkind: workflow\nnodes:\n  - [\n');

    const result = await runCli(['run', path, '--config-dir', dir]);

    expect(result.code).toBe(1);
    // The file is named, because a script may run many and "invalid workflow
    // document" alone does not say which.
    expect(result.output).toContain('Invalid workflow document (');
    expect(result.output).toContain('broken.archspace.yaml');
    expect(result.output).not.toContain('run started');
  });

  it('says which of the workflow’s requirements this machine lacks, and where to fix it', async () => {
    // "The workflow my colleague sent me will not run on my machine" is the
    // failure this product has to be good at, and only the local settings can
    // answer it (ARCHITECTURE §9.1). A bare `unknown-type` would be true and
    // useless: the operator needs to be told that `revit` is a binding they do
    // not have, and which file on *their* disk would carry it.
    const { dir, path } = await fixture(
      'needs-revit.archspace.yaml',
      workflowYaml('Needs Revit', [{ id: 'query', type: 'mcp.revit.query_model' }], { mcp: ['revit'] }),
    );

    const result = await runCli(['run', path, '--config-dir', dir]);

    expect(result.code).toBe(1);
    expect(result.output).toContain('This workflow declares requirements this machine does not satisfy');
    expect(result.output).toContain('mcp "revit" is not bound');
    // The path is spelled out, and it is the directory this invocation actually
    // used — not the default one, which is a different machine's answer.
    expect(result.output).toContain(join(dir, 'mcp.yaml'));
  });

  it('exits 2 with usage when no workflow file is given', async () => {
    // Distinct from 1 on purpose: 1 is "your workflow failed", 2 is "you typed
    // the command wrong", and a CI job is entitled to tell them apart.
    const result = await runCli(['run', '--config-dir', await tempDir()]);

    expect(result.code).toBe(2);
    expect(result.output).toContain('usage:');
    expect(result.output).toContain('--trust-plugin');
  });

  it('reports a workflow file that is not there, without a stack trace', async () => {
    const dir = await tempDir();

    const result = await runCli(['run', join(dir, 'absent.archspace.yaml'), '--config-dir', dir]);

    expect(result.code).toBe(1);
    expect(result.output).toContain('absent.archspace.yaml');
    // `main().catch` prints `err.message`, not the error. A stack trace here
    // would be the CLI telling a user about its own internals.
    expect(result.output).not.toContain('at async');
  });
});

describe('archspace nodes — the harness surface CI reads', () => {
  it('emits the core node roster as JSON and nothing else', async () => {
    // `--json` is the machine-readable path, so a stray log line from the MCP
    // or plugin host would not merely be untidy — it would make the output
    // unparseable for whatever consumes it.
    const result = await runCli(['nodes', '--json', '--config-dir', await tempDir()]);

    expect(result.code).toBe(0);
    const manifests: unknown = JSON.parse(result.output);
    expect(Array.isArray(manifests)).toBe(true);
    const types = (manifests as { type: string }[]).map((m) => m.type);
    // Superset, not equality: an unconsented plugin contributes nothing, but a
    // configured MCP server legitimately would.
    for (const type of coreNodeTypes()) expect(types).toContain(type);
  });
});

/**
 * What the CLI says when it refuses, which is the only thing a headless user
 * has to work with.
 *
 * Each of these printed something that was true and useless. The information
 * they needed had already been computed and was then dropped on the floor:
 * `extractWorkflow` knows which entry was malformed, `GraphValidationError`
 * carries the issue that names the bad target, and `readFile`'s errno
 * distinguishes the three mistakes a person actually makes.
 */
describe('a refusal that tells the user what to do', () => {
  it('names the mistyped target and lists the ids that exist', async () => {
    // Was: "graph validation failed with 1 error(s): unknown-target" — the
    // exception's internal roll-up, with every message under it discarded.
    const dir = await tempDir({
      'w.archspace.yaml': workflowYaml('Targets', [{ id: 'n_realid', type: 'aec.project_brief', config: {} }]),
    });
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml'), '--target', 'n_wrong']);
    expect(code).toBe(1);
    expect(output).toContain('n_wrong');
    expect(output).toContain('n_realid');
    expect(output).not.toContain('graph validation failed with');
  }, 60_000);

  it('says a directory is a directory', async () => {
    // Was: "EISDIR: illegal operation on a directory, read".
    const dir = await tempDir();
    const { code, output } = await runCli(['run', dir]);
    expect(code).toBe(1);
    expect(output).toContain('is a directory, not a workflow file');
    expect(output).not.toContain('EISDIR');
  }, 60_000);

  it('says a missing file is missing, and names it', async () => {
    const dir = await tempDir();
    const { code, output } = await runCli(['run', join(dir, 'absent.archspace.yaml')]);
    expect(code).toBe(1);
    expect(output).toContain('No such workflow file');
    expect(output).toContain('absent.archspace.yaml');
    expect(output).not.toContain('ENOENT');
  }, 60_000);

  it('points at the entry that is wrong, not merely at the file', async () => {
    // `extractWorkflow` computes `nodes[1]` for this and the CLI printed only
    // the message, so "node entry is not a map" arrived with no way to tell
    // which entry in a fifty-node file.
    const dir = await tempDir({
      'w.archspace.yaml': [
        'archspace: 1',
        'kind: workflow',
        'meta:',
        '  name: Malformed',
        'nodes:',
        '  - id: n_goodid',
        '    type: aec.project_brief',
        '    version: 1',
        '    config: {}',
        '  - "not a map at all"',
        'edges: []',
        'layout: {}',
        '',
      ].join('\n'),
    });
    const { code, output } = await runCli(['run', join(dir, 'w.archspace.yaml')]);
    expect(code).toBe(1);
    expect(output).toContain('nodes[1]');
    expect(output).toContain('node entry is not a map');
    // And the file it could not read, since a script may run many.
    expect(output).toContain('w.archspace.yaml');
  }, 60_000);
});
