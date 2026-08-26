/**
 * Document open/save — runs in the main process (it owns dialogs and fs).
 * Holds the CST source handle per open path so saves patch rather than
 * re-emit (§4.2 rule 3): comments and unknown fields survive round trips.
 */
import { app, dialog, type BrowserWindow } from 'electron';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  emitWorkflow,
  parseWorkflow,
  saveWorkflow,
  type WorkflowDoc,
  type WorkflowSource,
} from '@archspace/document';
import type { OpenResult, SaveResult } from '../shared/protocol';

const sources = new Map<string, WorkflowSource>();

/**
 * Namespace → plugin name for everything currently installed, kept up to date
 * from the engine's plugin-status pushes.
 *
 * The `requires:` block is derived from the node list on every save
 * (ARCHITECTURE §4.2 rule 7), and a node type alone cannot say which plugin
 * provides it — `aec.review.zoning` is a plugin's, `aec.project_brief` is
 * built in. Without this map the derivation would silently under-report the
 * plugin a workflow depends on, which is exactly the field a colleague opening
 * the file needs to be right.
 */
let pluginNamespaces: Record<string, string> = {};

export function setPluginNamespaces(map: Record<string, string>): void {
  pluginNamespaces = map;
}

/**
 * The workflows shipped with the app. All of them are copied into the user's
 * workflow directory on first launch; the first is the one that opens.
 */
const EXAMPLES = [
  'concept-compliance.archspace.yaml',
  'branching-review.archspace.yaml',
  'review-fix-report.archspace.yaml',
] as const;

/** Where the user's own copies of the examples live, and where Open starts. */
function workflowsDir(): string {
  return join(app.getPath('userData'), 'workflows');
}

export async function openPath(path: string): Promise<OpenResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = parseWorkflow(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${basename(path)} is not a valid workflow document.`,
      issues: parsed.issues,
    };
  }
  sources.set(path, parsed.source);
  return { ok: true, workflow: { path, doc: parsed.doc, issues: parsed.issues } };
}

export async function openWithDialog(win: BrowserWindow): Promise<OpenResult> {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Workflow',
    defaultPath: workflowsDir(),
    filters: [{ name: 'Archspace workflow', extensions: ['yaml'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
  return openPath(result.filePaths[0]);
}

/**
 * First launch ships the example workflows: the bundled resources are copied
 * into userData once, then opened like any user file, so edits and saves stick.
 * Existing copies are never overwritten — the user's edits win.
 */
export async function openDefault(resourcesDir: string): Promise<OpenResult> {
  const dir = workflowsDir();
  await mkdir(dir, { recursive: true });
  for (const name of EXAMPLES) {
    const target = join(dir, name);
    if (!existsSync(target)) {
      await copyFile(join(resourcesDir, name), target);
    }
  }
  return openPath(join(dir, EXAMPLES[0]));
}

export async function save(
  win: BrowserWindow,
  path: string | null,
  doc: WorkflowDoc,
): Promise<SaveResult> {
  let targetPath = path;
  if (targetPath === null) {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Workflow',
      defaultPath: join(app.getPath('documents'), 'untitled.archspace.yaml'),
      filters: [{ name: 'Archspace workflow', extensions: ['yaml'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    targetPath = result.filePath;
  }

  try {
    const source = sources.get(targetPath);
    const text = source
      ? saveWorkflow(source, doc, { pluginNamespaces })
      : emitWorkflow(doc, { pluginNamespaces });
    await writeFile(targetPath, text, 'utf8');
    if (!source) {
      // Adopt the freshly emitted text as the CST for subsequent patch-saves.
      const parsed = parseWorkflow(text);
      if (parsed.ok) sources.set(targetPath, parsed.source);
    }
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
