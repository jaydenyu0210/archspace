/**
 * Launch the built app and assert that its UI actually rendered
 * (ARCHITECTURE §3.2, ADR-0013).
 *
 * This exists because two launch-blocking bugs shipped past every gate at once:
 * the main bundle left workspace packages external and died with
 * ERR_MODULE_NOT_FOUND before opening a window, and once that was fixed an
 * unstable zustand selector made React give up with error #185 and mount
 * nothing. Both produced a product that did not work and a CI run that was
 * entirely green, because `tsc` reads source, the unit tests never construct a
 * window, and the headless CLI runs through tsx — a loader with none of
 * Electron's constraints.
 *
 * What it does: start Electron on the built `out/main/index.js` with the
 * DevTools Protocol open, wait for a page target, and ask the live DOM whether
 * the shell is there. Asserting on rendered elements rather than on "the
 * process did not exit" is the point — a blank window is a healthy process.
 *
 * The node-type count is the load-bearing assertion. Those manifests only exist
 * in the renderer if main spawned the engine child, the engine built its
 * registry, and the two agreed over a MessagePort — so one number covers the
 * whole chain that a unit test cannot reach.
 *
 * NOT wired into CI, deliberately. It needs a window server, and whether a
 * GitHub macOS runner reliably provides one is not something this repo has
 * verified; a flaky gate teaches people to re-run rather than to read. Run it
 * by hand after touching main, preload, the store, or the build config:
 *
 *     pnpm --filter @archspace/app build && pnpm --filter @archspace/app smoke
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9222;
const MAIN_INSPECT_PORT = 9229;
const DEADLINE_MS = 40_000;

/** The four settings tabs, and the menu action that opens each. */
const SETTINGS_TABS = ['mcp', 'ai', 'plugins', 'autodesk'];

/**
 * A throwaway userData directory, for two reasons.
 *
 * It keeps the run from writing to the developer's real profile — this script
 * grants plugin consent, which persists, so without isolation running it once
 * silently changed the state every later run observed. And it makes the run
 * DETERMINISTIC: a fresh profile always starts with the bundled plugin
 * unconsented and the example freshly copied, which is the state the flow below
 * is actually asserting about.
 */
const USER_DATA = await mkdtemp(join(tmpdir(), 'archspace-smoke-'));

/**
 * Refuse to run if something is already listening. Without this the script
 * happily attaches to whatever Electron is already on the port and reports
 * ITS state — which during development means testing a build you did not just
 * make. That misfired here once in each direction: a stale broken instance
 * failed a fixed build, and a stale good one would have passed a broken one,
 * which is the far worse half.
 */
try {
  await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(1500) });
  console.error(
    `smoke: something is already listening on :${PORT}.\n` +
      'Refusing to run, because attaching to it would report that process\n' +
      "instead of the build you just made. Close it (pkill -f Electron) and retry.",
  );
  process.exit(1);
} catch {
  // Nothing there: the state this script requires.
}

const child = spawn(
  join(APP, 'node_modules/.bin/electron'),
  [
    // `.` rather than the entry path, because Electron derives app.getAppPath()
    // from it and main resolves the bundled example workflows relative to that.
    // Pointed at out/main/index.js directly it looks for them in out/main and
    // opens an empty canvas — which still "renders", so this script would pass
    // while testing something no user will ever run.
    '.',
    `--user-data-dir=${USER_DATA}`,
    `--remote-debugging-port=${PORT}`,
    // The settings dialog opens from the native menu, which only main can
    // trigger. Inspecting main is how this drives it without a test-only hook
    // in the app itself.
    `--inspect=${MAIN_INSPECT_PORT}`,
  ],
  { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] },
);
let electronOutput = '';
child.stdout.on('data', (b) => (electronOutput += b));
child.stderr.on('data', (b) => (electronOutput += b));

const fail = (message) => {
  child.kill('SIGKILL');
  void rm(USER_DATA, { recursive: true, force: true });
  console.error(`smoke: ${message}`);
  if (electronOutput.trim()) console.error(`\n--- electron output ---\n${electronOutput.trim()}`);
  process.exit(1);
};

/** Poll the CDP endpoint until a page target exists, or give up. */
async function pageTarget() {
  const until = Date.now() + DEADLINE_MS;
  while (Date.now() < until) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Not listening yet. Electron takes a second or two to open the port.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

const page = await pageTarget();
if (!page) fail(`no page target on :${PORT} within ${DEADLINE_MS / 1000}s — the window never opened`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP socket failed')));
});

/**
 * React mounts in an effect, so the first paint can beat it. Retry rather than
 * sleep a guessed interval: a fixed wait is either flaky or slow, and on a
 * loaded machine it is both.
 */
const EXPR = `JSON.stringify({
  wordmark: document.querySelector('.wordmark')?.innerText ?? null,
  panels: [...document.querySelectorAll('.toolbar,.library,.inspector,.react-flow')].map(e => e.className.split(' ')[0]),
  nodeTypes: document.querySelectorAll('.lib-item').length,
  docName: document.querySelector('.doc-name')?.innerText ?? null,
  canvasNodes: document.querySelectorAll('.node').length,
})`;

let ui = null;
for (let attempt = 0; attempt < 25 && ui?.wordmark == null; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
  const id = 100 + attempt;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
  const reply = await new Promise((r) => {
    const on = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === id) {
        ws.removeEventListener('message', on);
        r(msg);
      }
    };
    ws.addEventListener('message', on);
  });
  const value = reply.result?.result?.value;
  if (typeof value === 'string') ui = JSON.parse(value);
}

/** Evaluate in the renderer and return the parsed JSON string it produced. */
async function evaluate(socket, id, expression, { commandLineAPI = false } = {}) {
  // `require` is only in scope for a main-process evaluation when the command
  // line API is exposed; without it the expression throws ReferenceError and
  // the reply comes back as a silent null.
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, includeCommandLineAPI: commandLineAPI },
  }));
  const reply = await new Promise((r) => {
    const on = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === id) {
        socket.removeEventListener('message', on);
        r(msg);
      }
    };
    socket.addEventListener('message', on);
  });
  if (reply.result?.exceptionDetails) {
    fail(`evaluate #${id} threw: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
  }
  const value = reply.result?.result?.value;
  return typeof value === 'string' ? JSON.parse(value) : null;
}

/**
 * Open each settings tab and confirm it drew something.
 *
 * These four panels are the largest surface in the app and the one no unit test
 * can reach: they are only reachable through a native menu item, and their
 * content comes from live engine state. An unstable selector in any of them
 * fails exactly the way Inspector's did — a blank panel and no error — so
 * "did it render" is the assertion worth making.
 */
const mainTargets = await (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json`)).json();
const mainWs = new WebSocket(mainTargets[0].webSocketDebuggerUrl);
await new Promise((r) => mainWs.addEventListener('open', r));

/** Fire the native menu item that opens one settings tab, from main. */
let menuSeq = 500;
async function openSettingsTab(tab) {
  mainWs.send(JSON.stringify({
    id: ++menuSeq,
    method: 'Runtime.evaluate',
    params: {
      expression: `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu','settings-${tab}'), 'ok'`,
      includeCommandLineAPI: true,
    },
  }));
  await new Promise((r) => setTimeout(r, 900));
}

const panels = [];
for (const tab of SETTINGS_TABS) {
  await openSettingsTab(tab);
  const seen = await evaluate(ws, 600 + panels.length, `JSON.stringify({
    open: !!document.querySelector('[role=dialog]'),
    active: document.querySelector('[role=tab][aria-selected=true]')?.innerText ?? null,
    chars: document.querySelector('.settings-panel')?.innerText?.length ?? 0,
    stub: /not built yet/i.test(document.querySelector('.settings-panel')?.innerText ?? ''),
  })`);
  if (!seen?.open) fail(`the settings dialog did not open on the "${tab}" tab`);
  if (seen.stub) fail(`the "${tab}" panel is still a stub`);
  // A rendered panel is well over a screenful; a blank one is zero. The
  // threshold only has to separate those two, not measure anything.
  if (seen.chars < 200) fail(`the "${tab}" panel rendered ${seen.chars} characters — effectively blank`);
  panels.push(`${tab}:${seen.chars}`);
}
/**
 * The out-of-the-box flow, end to end, because it is the one that matters and
 * the one no other test can reach: consent to the bundled plugin through the
 * UI, then run the bundled example.
 *
 * Passing it means the consent UI wrote a grant, the plugin host read it,
 * spawned a process, loaded the plugin, registered its node types, pushed them
 * to the renderer, and the engine then ran a graph that depends on one of them.
 * That is the whole integration layer in a single assertion, and it starts from
 * the state a new user is actually in — the profile is fresh, so the plugin
 * begins unconsented exactly as it does on a first launch.
 */
const before = await evaluate(ws, 700, `JSON.stringify({ types: document.querySelectorAll('.lib-item').length })`);

// Re-open the plugins tab. The loop above ends on whichever tab is last in
// SETTINGS_TABS, so the consent button is not on screen by then — assuming it
// was is why this failed the first time it ran.
await openSettingsTab('plugins');
await evaluate(ws, 701, `[...document.querySelectorAll('.settings-panel button')].find(b => /grant consent/i.test(b.innerText))?.click(), '"ok"'`);

let consented = null;
for (let i = 0; i < 20 && (consented?.reviewTypes ?? 0) === 0; i++) {
  await new Promise((r) => setTimeout(r, 700));
  consented = await evaluate(ws, 720 + i, `JSON.stringify({
    types: document.querySelectorAll('.lib-item').length,
    reviewTypes: [...document.querySelectorAll('.lib-item-type')].filter(e => e.innerText.startsWith('aec.review.')).length,
  })`);
}
if (!consented || consented.reviewTypes === 0) {
  fail('granting consent did not load the bundled plugin — no aec.review.* types reached the palette');
}

// Close the dialog and run what is on the canvas.
await evaluate(ws, 760, `document.querySelector('[role=dialog]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})), '"ok"'`);
await new Promise((r) => setTimeout(r, 600));
await evaluate(ws, 761, `document.querySelector('.tb-run')?.click(), '"ok"'`);

let run = null;
for (let i = 0; i < 40 && !run?.done; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  run = await evaluate(ws, 800 + i, `JSON.stringify({
    done: /run finished/i.test(document.body.innerText),
    final: [...document.querySelectorAll('.log-final')].slice(-1)[0]?.innerText ?? null,
    notices: [...document.querySelectorAll('.notice')].map(e => e.innerText.slice(0, 160)),
  })`);
}
if (!run?.done) fail(`the run never finished; notices: ${JSON.stringify(run?.notices ?? [])}`);
if (!/succeeded/i.test(run.final ?? '')) fail(`the run did not succeed: ${run.final ?? '(no final line)'}`);

/**
 * Saving a produced file, all the way to bytes on disk.
 *
 * This is the only test that can cover the chain at all: the Save button is in
 * a sandboxed renderer, the file dialog is in main, and the bytes are in the
 * engine child's in-memory store. Nothing else in this repository spans those
 * three processes, and every leg of it is a wire that fails silently — a
 * mistyped IPC channel name, a preload method that was never exposed, a
 * control-channel case that falls through, a Uint8Array that does not survive
 * structured clone. All of those produce a button that does nothing.
 *
 * The save dialog is stubbed from here rather than driven, because it is a
 * native modal that CDP cannot reach. Stubbing it is the harness reaching into
 * the process it launched; nothing test-shaped exists in the app itself.
 */
const SAVED_TO = join(USER_DATA, 'smoke-saved-output');
await evaluate(mainWs, 900, `(() => {
  const { dialog } = require('electron');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(SAVED_TO)} });
  return '"ok"';
})()`, { commandLineAPI: true });

// Outputs are shown for the inspected node, so the DXF exporter has to be
// selected first — the same two clicks a user makes.
await evaluate(ws, 901, `(() => {
  const node = [...document.querySelectorAll('.react-flow__node')].find(n => /DXF/i.test(n.innerText));
  if (!node) return '"no-node"';
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  node.click();
  return '"ok"';
})()`);
await new Promise((r) => setTimeout(r, 600));

const assets = await evaluate(ws, 902, `JSON.stringify({
  cards: document.querySelectorAll('.preview-asset').length,
  buttons: document.querySelectorAll('.asset-save').length,
  names: [...document.querySelectorAll('.asset-name')].map(e => e.innerText),
  bridge: typeof window.archspace?.saveAsset,
})`);

if (assets?.bridge !== 'function') fail(`window.archspace.saveAsset is ${assets?.bridge} — the preload bridge does not expose it`);
if ((assets?.cards ?? 0) !== 1) fail(`expected one asset card on the DXF exporter; found ${assets?.cards ?? 0} (${JSON.stringify(assets?.names ?? [])})`);
if (assets.buttons !== assets.cards) fail(`${assets.cards} asset cards but ${assets.buttons} save buttons`);

await evaluate(ws, 903, `document.querySelector('.asset-save')?.click(), '"ok"'`);

let saved = null;
for (let i = 0; i < 15 && !saved?.done; i++) {
  await new Promise((r) => setTimeout(r, 400));
  saved = await evaluate(ws, 910 + i, `JSON.stringify({
    done: !!document.querySelector('.asset-saved') || !!document.querySelector('.asset-error'),
    path: document.querySelector('.asset-saved')?.innerText ?? null,
    error: document.querySelector('.asset-error')?.innerText ?? null,
  })`);
}
if (saved?.error) fail(`saving the asset failed in-app: ${saved.error}`);
if (!saved?.done) fail('the Save button reported neither success nor failure — the IPC round trip never returned');

// The renderer claiming success is not the same as a file existing. Read it.
const savedBytes = await readFile(SAVED_TO).catch(() => null);
if (savedBytes === null) fail(`the app reported "${saved.path}" but ${SAVED_TO} does not exist`);
if (savedBytes.byteLength === 0) fail('the saved file is empty');
// The DXF exporter's output, not some other buffer that happened to be around:
// R12 group-code framing from the first byte.
const head = savedBytes.subarray(0, 64).toString('latin1');
if (!head.startsWith('  0\r\nSECTION')) {
  fail(`the saved file is not the DXF the selected node produced; it starts: ${JSON.stringify(head.slice(0, 40))}`);
}

mainWs.close();

ws.close();
child.kill('SIGTERM');
await rm(USER_DATA, { recursive: true, force: true });

if (!ui || ui.wordmark === null) {
  fail('the renderer mounted nothing — an empty body is what React error #185 looks like from outside');
}
for (const panel of ['toolbar', 'library', 'inspector', 'react-flow']) {
  if (!ui.panels.includes(panel)) fail(`the "${panel}" panel is missing; rendered: [${ui.panels.join(', ')}]`);
}
if (ui.nodeTypes === 0) {
  fail('the node palette is empty — main did not spawn the engine child, or it never delivered its manifests');
}
// The bundled example is what a first launch actually shows, and reaching it
// exercises the resources path, the copy into userData, the parser and the
// canvas. An app that renders an empty document looks healthy and is not.
if (ui.canvasNodes === 0) {
  fail(`no nodes on the canvas — the bundled example did not open (document: ${ui.docName ?? 'none'})`);
}

console.log(
  `smoke: UI rendered — ${ui.panels.length} panels, ${ui.nodeTypes} node types in the palette\n` +
    `       opened "${ui.docName}" with ${ui.canvasNodes} nodes on the canvas\n` +
    `       settings tabs rendered — ${panels.join(', ')} (characters)\n` +
    `       consent granted in-app — palette ${before.types} -> ${consented.types} types, ${consented.reviewTypes} from the plugin\n` +
    `       ${(run.final ?? '').trim()}\n` +
    `       saved through the UI — clicked Save on the DXF exporter, ${savedBytes.byteLength} bytes of valid R12 landed on disk`,
);
