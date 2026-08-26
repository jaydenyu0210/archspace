/**
 * @archspace/node-sdk/testkit — run any NodeModule against fixture inputs and
 * params with an in-memory ctx (mock assets, scriptable ai, captured logs and
 * progress). No app, no engine, no Electron (ADR-0013 §4).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySchemaDefaults,
  createMemoryAssetStore,
  markRetryable,
  MemoryAssetStore,
  type AiGateway,
  type Inputs,
  type LogLevel,
  type NodeContext,
  type NodeModule,
  type Outputs,
  type Value,
} from './index.js';

export interface CapturedLog {
  level: LogLevel;
  message: string;
  data?: Value;
}

export interface CapturedProgress {
  fraction?: number;
  message?: string;
}

export interface RunNodeOptions {
  params?: Record<string, unknown>;
  inputs?: Record<string, Value | undefined>;
  secrets?: Record<string, string>;
  /** Script the ai gateway; unscripted methods reject with a clear error. */
  ai?: Partial<AiGateway>;
  assets?: MemoryAssetStore;
  signal?: AbortSignal;
  runId?: string;
  /** Merge manifest param defaults under the given params (default true). */
  applyDefaults?: boolean;
}

export interface RunNodeResult<P = unknown> {
  outputs: Outputs;
  logs: CapturedLog[];
  progress: CapturedProgress[];
  assets: MemoryAssetStore;
  /** The params the node actually saw (after defaults). */
  params: P;
}

function unscripted(method: string): never {
  throw new Error(`testkit: ctx.ai.${method} was called but not scripted — pass { ai: { ${method}: … } }`);
}

export async function runNode<P>(mod: NodeModule<P>, options: RunNodeOptions = {}): Promise<RunNodeResult<P>> {
  const assets = options.assets ?? createMemoryAssetStore();
  const logs: CapturedLog[] = [];
  const progress: CapturedProgress[] = [];
  const secrets = options.secrets ?? {};
  const tempDirs: string[] = [];

  const params = (options.applyDefaults === false
    ? (options.params ?? {})
    : applySchemaDefaults(mod.manifest.params, options.params)) as P;

  const ctx: NodeContext = {
    signal: options.signal ?? new AbortController().signal,
    runId: options.runId ?? 'test-run',
    nodeId: `test-${mod.manifest.type}`,
    log: (level, message, data) => {
      logs.push(data === undefined ? { level, message } : { level, message, data });
    },
    progress: (fraction, message) => {
      progress.push({
        ...(fraction !== undefined ? { fraction } : {}),
        ...(message !== undefined ? { message } : {}),
      });
    },
    assets,
    secrets: {
      get: async (key) => {
        const value = secrets[key];
        if (value === undefined) throw new Error(`testkit: secret "${key}" not provided`);
        return value;
      },
    },
    ai: {
      generateText: options.ai?.generateText ?? (() => unscripted('generateText')),
      generateObject: options.ai?.generateObject ?? (() => unscripted('generateObject')),
      embed: options.ai?.embed ?? (() => unscripted('embed')),
    },
    tempDir: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'archspace-testkit-'));
      tempDirs.push(dir);
      return dir;
    },
    retryable: markRetryable,
  };

  try {
    const outputs = await mod.execute(ctx, (options.inputs ?? {}) as Inputs, params);
    return { outputs, logs, progress, assets, params };
  } finally {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}
