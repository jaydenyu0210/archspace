/**
 * archspace — the headless runner and the integration harness (ADR-0013).
 *
 *   archspace run <workflow.archspace.yaml> [--target <nodeId>] [--out <dir>] [--trust-plugin <id>]
 *   archspace nodes                      what node types are available here
 *   archspace plugins                    installed plugins and their state
 *   archspace mcp [--connect <name>]     configured MCP servers and their tools
 *   archspace ai [--probe <profile>]     model profiles and their readiness
 *   archspace doctor                     everything above, as one report
 *
 * `doctor` exists because the failure mode this app has to be good at is
 * "the workflow my colleague sent me will not run on my machine". A workflow's
 * `requires:` block names logical MCP servers, model profiles and plugins;
 * only this machine's settings say what those resolve to (ARCHITECTURE §9.1,
 * §10), so the diagnosis has to be local and specific.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { parseWorkflow } from '@archspace/document';
import { startRun, toEngineGraph, validateGraph, type EngineGraph, type RunEvent } from '@archspace/engine';
import { assetFileName, type AssetRef, type AssetStore } from '@archspace/node-sdk';
import { envVarForSecret } from './config.js';
import { createRuntime, type Runtime } from './runtime.js';

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}
function options(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[++i]);
  }
  return out;
}

/**
 * This package's own version, read from its `package.json` rather than baked in
 * by a build step — the CLI runs from source under `tsx` as often as it runs
 * bundled, and a constant here is a second place for the number to live and a
 * first place for it to be wrong.
 */
function cliVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'));
  const version = (pkg as { version?: unknown }).version;
  return typeof version === 'string' ? version : '0.0.0-unknown';
}

/** Exit 2 when we are correcting the caller, 0 when they asked. */
function usage(code = 2): never {
  const write = code === 0 ? console.log : console.error;
  write(
    [
      'usage:',
      '  archspace run <workflow.archspace.yaml> [--target <nodeId>] [--out <dir>]',
      '  archspace nodes [--json]',
      '  archspace plugins',
      '  archspace mcp [--connect <name>]',
      '  archspace ai [--probe <profile>]',
      '  archspace doctor [<workflow.archspace.yaml>]',
      '  archspace --version',
      '',
      'run flags:',
      '  --out <dir>             write every file the run produces into <dir>',
      '                          (DXF drawings, IFC models, CSV tables, reports)',
      '',
      'common flags:',
      '  --config-dir <dir>      settings directory (default: the desktop app’s)',
      '  --no-plugins            skip the plugin host entirely',
      '  --trust-plugin <id>     consent to a plugin for this run only (repeatable);',
      '                          grants exactly the permissions it declares',
      '  --verbose               include debug/info logs from the MCP and plugin hosts',
    ].join('\n'),
  );
  process.exit(code);
}

async function runtime(): Promise<Runtime> {
  return createRuntime({
    ...(option('config-dir') !== undefined ? { configDir: option('config-dir') as string } : {}),
    noPlugins: flag('no-plugins'),
    verbose: flag('verbose'),
    trustPlugins: options('trust-plugin'),
  });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function fmtEvent(e: RunEvent, t0: number): string {
  // The engine stamps `at` from its own clock, which can read a hair before
  // t0; clamp so the first events don't print as "+-0.00s".
  const t = `+${(Math.max(0, e.at - t0) / 1000).toFixed(2)}s`.padStart(8);
  switch (e.type) {
    case 'run:started': return `${t}  run started   ${e.runId} (targets: ${e.targets.length})`;
    case 'node:queued': return `${t}  queued        ${e.nodeId}`;
    case 'node:started': return `${t}  running       ${e.nodeId}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`;
    case 'node:progress': return `${t}  progress      ${e.nodeId} ${e.fraction !== undefined ? `${Math.round(e.fraction * 100)}%` : ''} ${e.message ?? ''}`;
    case 'node:log': return `${t}  log[${e.level}]    ${e.nodeId} ${e.message}`;
    case 'node:succeeded': return `${t}  complete      ${e.nodeId}${e.cached ? ' (cached)' : ''} in ${e.durationMs}ms`;
    case 'node:failed': return `${t}  FAILED        ${e.nodeId} (${e.kind}${e.willRetry ? ', will retry' : ''}): ${e.message}`;
    case 'node:skipped': return `${t}  skipped       ${e.nodeId} (${e.reason})`;
    case 'run:finished': return `${t}  run finished  ${e.status} — ${e.stats.succeeded} complete (${e.stats.cached} cached), ${e.stats.failed} failed, ${e.stats.skipped} skipped, ${(e.stats.durationMs / 1000).toFixed(2)}s`;
  }
}

async function cmdRun(file: string): Promise<number> {
  const text = await readFile(file, 'utf8');
  const parsed = parseWorkflow(text);
  if (!parsed.ok) {
    console.error('Invalid workflow document:');
    for (const issue of parsed.issues) console.error(`  [${issue.severity}] ${issue.message}`);
    return 1;
  }
  for (const issue of parsed.issues) console.warn(`  [${issue.severity}] ${issue.message}`);

  const rt = await runtime();
  try {
    for (const issue of rt.config.issues) console.warn(`  [warning] ${issue}`);

    const graph: EngineGraph = toEngineGraph(parsed.doc);

    const issues = validateGraph(graph, rt.registry);
    for (const issue of issues) console.warn(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
    if (issues.some((i) => i.severity === 'error')) {
      console.error('\nValidation failed — not running.');
      await reportMissingRequirements(rt, parsed.doc.requires);
      return 1;
    }

    const targets = options('target');
    console.log(`Running ${parsed.doc.meta.name} (${graph.nodes.length} nodes)\n`);
    const handle = startRun(graph, {
      registry: rt.registry,
      assets: rt.assets,
      ai: rt.ai,
      laneCaps: rt.laneCaps,
      ...(targets.length > 0 ? { targets } : {}),
    });
    const t0 = Date.now();

    // Assets are collected from the run events rather than by walking outputs
    // afterwards, because `outputPreviews` is where an AssetRef is already
    // announced and a preview is capped precisely so nobody has to hold the
    // bytes to know a file exists (§7.6).
    const produced: { nodeId: string; port: string; ref: AssetRef }[] = [];
    handle.onEvent((e) => {
      console.log(fmtEvent(e, t0));
      if (e.type !== 'node:succeeded') return;
      for (const output of e.outputPreviews) {
        if (output.preview.kind === 'asset') {
          produced.push({ nodeId: e.nodeId, port: output.port, ref: output.preview.ref });
        }
      }
    });

    const sigint = (): void => {
      console.error('\ncancelling…');
      handle.cancel();
    };
    process.on('SIGINT', sigint);

    const result = await handle.done;
    process.off('SIGINT', sigint);

    const outDir = option('out');
    if (outDir !== undefined) {
      const written = await writeAssets(rt.assets, produced, outDir);
      if (written === null) return 1;
    } else if (produced.length > 0) {
      // Saying nothing here means a run that generated a drawing looks
      // identical to one that generated nothing.
      const names = produced.map((a) => assetFileName(a.ref)).join(', ');
      console.log(`\n${produced.length} file(s) produced (${names}) — pass --out <dir> to write them.`);
    }

    return result.status === 'succeeded' ? 0 : 1;
  } finally {
    await rt.close();
  }
}

/**
 * Write a run's assets into a directory, one file each.
 *
 * Names come from `assetFileName`, which reduces a node-supplied hint to a
 * single safe path segment — the hint is a display string and nothing stops a
 * node, or an MCP tool this project did not write, from putting `../` in it.
 * The node id and port are the fallback stem, so two nodes emitting an
 * unnamed asset do not collide; identical names from different ports still can,
 * and are reported rather than silently overwritten.
 *
 * Returns null if anything failed, so the caller can exit non-zero: a run that
 * says "succeeded" and then could not write the file the user asked for has
 * not done what was asked.
 */
async function writeAssets(
  assets: AssetStore,
  produced: { nodeId: string; port: string; ref: AssetRef }[],
  outDir: string,
): Promise<string[] | null> {
  const dir = resolvePath(outDir);

  // The directory is created even when there is nothing to put in it, so
  // `--out x` means "x exists and holds this run's files" with no exceptions.
  // Skipping it made `archspace run --out x && ls x` fail with an ENOENT that
  // had nothing to do with what went wrong.
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    console.error(`\nCould not create ${dir}: ${reason(err)}`);
    return null;
  }

  if (produced.length === 0) {
    console.log(`\nNo files to write to ${dir} — this run produced none.`);
    return [];
  }

  const written: string[] = [];
  const taken = new Set<string>();
  let failed = false;

  console.log('');
  for (const { nodeId, port, ref } of produced) {
    const name = assetFileName(ref, `${nodeId}.${port}`);
    if (taken.has(name)) {
      console.error(`  ! ${name} — two outputs claim this name; the later one was not written`);
      failed = true;
      continue;
    }
    taken.add(name);

    try {
      const bytes = await assets.bytes(ref);
      await writeFile(join(dir, name), bytes);
      written.push(name);
      console.log(`  wrote ${join(dir, name)} (${(ref.size / 1024).toFixed(1)} KB, ${nodeId}.${port})`);
    } catch (err) {
      console.error(`  ! ${name} — ${reason(err)}`);
      failed = true;
    }
  }

  return failed ? null : written;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** After a validation failure, say which of `requires:` this machine lacks. */
async function reportMissingRequirements(
  rt: Runtime,
  requires: { mcp: string[]; ai: string[]; plugins: string[] },
): Promise<void> {
  const lines: string[] = [];

  for (const name of requires.mcp) {
    const status = rt.mcp.status(name);
    if (status === undefined) {
      lines.push(`  mcp "${name}" is not bound — add it to ${rt.config.dir}/mcp.yaml`);
    } else if (status.state !== 'connected') {
      lines.push(`  mcp "${name}" is ${status.state}${status.error !== undefined ? `: ${status.error}` : ''}`);
    }
  }

  const profiles = await rt.ai.listProfiles();
  for (const name of requires.ai) {
    const profile = profiles.find((p) => p.name === name);
    if (profile === undefined) lines.push(`  ai profile "${name}" is not defined — add it to ${rt.config.dir}/ai.yaml`);
    else if (profile.readiness !== 'ready') lines.push(`  ai profile "${name}" is ${profile.readiness}: ${profile.detail ?? ''}`);
  }

  // `rt.plugins` is null only under --no-plugins. Reporting that as "not
  // installed" blamed the machine for something the operator had just asked
  // for on the command line, and sent them looking for a plugin that is
  // sitting right there.
  if (rt.plugins === null && requires.plugins.length > 0) {
    lines.push(`  the plugin host is disabled (--no-plugins), so ${requires.plugins.join(', ')} cannot load`);
  } else {
    const installed = rt.plugins?.list() ?? [];
    for (const name of requires.plugins) {
      const plugin = installed.find((p) => p.id === name || p.manifest.name === name);
      if (plugin === undefined) lines.push(`  plugin "${name}" is not installed`);
      else if (plugin.state === 'needs-consent') {
        // The one unsatisfied requirement with a fix the operator can act on
        // in the same shell, so it says what that fix is.
        lines.push(`  plugin "${name}" has not been consented to — re-run with --trust-plugin ${name}, or enable it in the app`);
      } else if (plugin.state !== 'loaded') {
        lines.push(`  plugin "${name}" is ${plugin.state}${plugin.error !== undefined ? `: ${plugin.error}` : ''}`);
      }
    }
  }

  if (lines.length > 0) {
    console.error('\nThis workflow declares requirements this machine does not satisfy:');
    for (const line of lines) console.error(line);
  }
}

// ---------------------------------------------------------------------------
// nodes / plugins / mcp / ai / doctor
// ---------------------------------------------------------------------------

async function cmdNodes(): Promise<number> {
  const rt = await runtime();
  try {
    const manifests = rt.registry.manifests().sort((a, b) => a.type.localeCompare(b.type));
    if (flag('json')) {
      console.log(JSON.stringify(manifests, null, 2));
      return 0;
    }
    const width = Math.max(...manifests.map((m) => m.type.length));
    for (const m of manifests) {
      console.log(`${m.type.padEnd(width)}  v${m.version}  ${m.category.padEnd(10)}  ${m.label}`);
    }
    console.log(`\n${manifests.length} node types`);
    return 0;
  } finally {
    await rt.close();
  }
}

async function cmdPlugins(): Promise<number> {
  const rt = await runtime();
  try {
    const list = rt.plugins?.list() ?? [];
    if (list.length === 0) {
      console.log('No plugins found.');
      return 0;
    }
    for (const p of list) {
      console.log(`${p.id}  ${p.manifest.version}  [${p.state}]  ${p.source}`);
      console.log(`  ${p.manifest.displayName} — namespace ${p.manifest.namespace}`);
      console.log(`  nodes: ${p.nodeTypes.length > 0 ? p.nodeTypes.join(', ') : '(none)'}`);
      if (p.manifest.permissions.length > 0) {
        console.log(`  requests: ${p.manifest.permissions.join(', ')}  granted: ${p.grantedPermissions.join(', ') || '(none)'}`);
      }
      if (p.containsNativeCode) console.log('  contains native code');
      if (p.error !== undefined) console.log(`  error: ${p.error}`);
      console.log('');
    }
    // `needs-consent` is not a fault. It is the state every bundled plugin is
    // in until a human decides, so exiting non-zero on it meant the very first
    // `archspace plugins` a user ran reported failure for the plugin the
    // product itself ships — and any script inventorying plugins broke on a
    // machine that was working exactly as designed. `doctor`, which is the
    // command that answers "is this machine healthy", already returns 0 here;
    // the two disagreed about the same fact.
    //
    // `failed` and `incompatible` genuinely are faults: the plugin was meant to
    // load and did not, and that is worth a non-zero exit for CI to branch on.
    const faulted = list.filter((p) => p.state === 'failed' || p.state === 'incompatible');
    return faulted.length > 0 ? 1 : 0;
  } finally {
    await rt.close();
  }
}

async function cmdMcp(): Promise<number> {
  const rt = await runtime();
  try {
    const connect = options('connect');
    for (const name of connect) {
      process.stdout.write(`connecting ${name}… `);
      try {
        await rt.mcp.connect(name);
        console.log('ok');
      } catch (err) {
        console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const servers = rt.mcp.list();
    if (servers.length === 0) {
      console.log(`No MCP servers configured. Add them to ${rt.config.dir}/mcp.yaml.`);
      return 0;
    }
    for (const s of servers) {
      console.log(`${s.name}  [${s.state}]  ${s.transport}  ${s.target}`);
      if (s.unsupportedReason !== undefined) console.log(`  unsupported here: ${s.unsupportedReason}`);
      if (s.error !== undefined) console.log(`  error: ${s.error}`);
      if (s.serverInfo !== undefined) console.log(`  server: ${s.serverInfo.name} ${s.serverInfo.version} (MCP ${s.protocolVersion ?? '?'})`);
      for (const tool of s.tools) {
        console.log(`    mcp.${s.name}.${tool.name}  ${tool.description?.split('\n')[0] ?? ''}`);
      }
      console.log('');
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function cmdAi(): Promise<number> {
  const rt = await runtime();
  try {
    const probe = option('probe');
    if (probe !== undefined) {
      process.stdout.write(`probing "${probe}"… `);
      const result = await rt.ai.probe(probe);
      if (result.ok) {
        console.log(`ok in ${result.latencyMs ?? 0}ms`);
        if (result.sample !== undefined) console.log(`  model said: ${result.sample}`);
        return 0;
      }
      console.log(`failed: ${result.error ?? 'unknown error'}`);
      return 1;
    }

    const profiles = await rt.ai.listProfiles();
    if (profiles.length === 0) {
      console.log(`No model profiles configured. Add them to ${rt.config.dir}/ai.yaml.`);
      return 0;
    }
    for (const p of profiles) {
      const marker = p.isDefault ? '*' : ' ';
      console.log(`${marker} ${p.name}  ${p.provider} (${p.providerKind})  ${p.model}  [${p.readiness}]`);
      if (p.detail !== undefined) console.log(`    ${p.detail}`);
      if (p.apiKeyRef !== undefined) console.log(`    key ref "${p.apiKeyRef}" → env ${envVarForSecret(p.apiKeyRef)}`);
      if (p.baseUrl !== undefined) console.log(`    endpoint ${p.baseUrl}`);
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function cmdDoctor(file: string | undefined): Promise<number> {
  const rt = await runtime();
  try {
    console.log(`Settings directory: ${rt.config.dir}`);
    for (const issue of rt.config.issues) console.log(`  ! ${issue}`);
    console.log('');

    const manifests = rt.registry.manifests();
    console.log(`Node types: ${manifests.length}`);
    const plugins = rt.plugins?.list() ?? [];
    console.log(`Plugins: ${plugins.length} (${plugins.filter((p) => p.state === 'loaded').length} loaded)`);
    for (const p of plugins.filter((x) => x.state !== 'loaded')) {
      console.log(`  ! ${p.id} is ${p.state}${p.error !== undefined ? `: ${p.error}` : ''}`);
    }

    const servers = rt.mcp.list();
    console.log(`MCP servers: ${servers.length}`);
    for (const s of servers) {
      console.log(`  ${s.name}: ${s.state}${s.unsupportedReason !== undefined ? ` — ${s.unsupportedReason}` : ''}`);
    }

    const profiles = await rt.ai.listProfiles();
    console.log(`AI profiles: ${profiles.length}`);
    for (const p of profiles) console.log(`  ${p.name}: ${p.readiness}${p.detail !== undefined ? ` — ${p.detail}` : ''}`);

    if (file !== undefined) {
      console.log('');
      const text = await readFile(file, 'utf8');
      const parsed = parseWorkflow(text);
      if (!parsed.ok) {
        console.log(`${file} is not a valid workflow document.`);
        return 1;
      }
      console.log(`${parsed.doc.meta.name} requires:`);
      console.log(`  mcp: ${parsed.doc.requires.mcp.join(', ') || '(none)'}`);
      console.log(`  ai: ${parsed.doc.requires.ai.join(', ') || '(none)'}`);
      console.log(`  plugins: ${parsed.doc.requires.plugins.join(', ') || '(none)'}`);
      await reportMissingRequirements(rt, parsed.doc.requires);
      const graph: EngineGraph = toEngineGraph(parsed.doc);
      const issues = validateGraph(graph, rt.registry);
      if (issues.length === 0) console.log('\nThis workflow is ready to run here.');
      else for (const issue of issues) console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    return 0;
  } finally {
    await rt.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let code: number;
  switch (command) {
    case '--version':
    case '-v':
    case 'version':
      // ARCHITECTURE §16's M0 gate is "`archspace --version` runs from a fresh
      // checkout", and it did not: the flag fell through to `usage()` and
      // exited 2. A gate a milestone was declared against has to be executable,
      // so this is the command being made real rather than the gate being
      // edited to match. It takes no runtime — a version that needed the MCP
      // and plugin hosts up would be a poor answer to "is this thing installed".
      console.log(cliVersion());
      code = 0;
      break;
    case '--help':
    case '-h':
    case 'help':
      usage(0);
      break;
    case 'run':
      if (argv[1] === undefined || argv[1].startsWith('--')) usage();
      code = await cmdRun(argv[1]);
      break;
    case 'nodes':
      code = await cmdNodes();
      break;
    case 'plugins':
      code = await cmdPlugins();
      break;
    case 'mcp':
      code = await cmdMcp();
      break;
    case 'ai':
      code = await cmdAi();
      break;
    case 'doctor':
      code = await cmdDoctor(argv[1] !== undefined && !argv[1].startsWith('--') ? argv[1] : undefined);
      break;
    default:
      usage();
  }
  process.exit(code);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
