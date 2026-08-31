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
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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

/**
 * Refuse to run against a build older than the source it was built from.
 *
 * This script launches whatever is in `out/`, so a failed `pnpm build` leaves
 * it testing the previous build — and reporting a pass for code that does not
 * compile. That happened: a syntax error esbuild rejected and `tsc --noEmit`
 * did not, and the smoke test went green on the stale bundle immediately
 * afterwards. A stale pass is worse than no test, because it is trusted.
 */
async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    // node_modules is not ours and dominates the walk.
    if (entry.parentPath.includes('node_modules')) continue;
    newest = Math.max(newest, (await stat(join(entry.parentPath, entry.name))).mtimeMs);
  }
  return newest;
}

const [srcTime, outTime] = await Promise.all([
  newestMtime(join(APP, 'src')),
  newestMtime(join(APP, 'out')).catch(() => 0),
]);
if (outTime === 0) {
  console.error('smoke: no build in out/ — run `pnpm build` first.');
  process.exit(1);
}
if (srcTime > outTime) {
  console.error(
    `smoke: out/ is older than src/ by ${Math.round((srcTime - outTime) / 1000)}s.\n` +
      'Refusing to run, because this would report a pass for the previous build.\n' +
      'Run `pnpm build` and check that it succeeded.',
  );
  process.exit(1);
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
 *
 * The loop waits for the DOCUMENT, not just the wordmark. The two arrive
 * separately — React mounts locally, while the bundled example travels main →
 * renderer over IPC — so a loop that stopped at the wordmark captured
 * `canvasNodes: 0` whenever the machine was busy enough for the mount to win
 * that race. Nothing failed at the capture; the stale zero was carried a
 * hundred lines down to the drop test, which then reported the graph changing
 * from 0 to 7 nodes and blamed a dropped file for the document simply having
 * loaded. A snapshot has to be coherent to be compared against later.
 *
 * A document that genuinely never opens still exits this loop, on the attempt
 * ceiling, and is still caught — by the assertion at the end that says so in
 * those words.
 */
const EXPR = `JSON.stringify({
  wordmark: document.querySelector('.wordmark')?.innerText ?? null,
  panels: [...document.querySelectorAll('.toolbar,.library,.inspector,.react-flow')].map(e => e.className.split(' ')[0]),
  nodeTypes: document.querySelectorAll('.lib-item').length,
  docName: document.querySelector('.doc-name')?.innerText ?? null,
  canvasNodes: document.querySelectorAll('.node').length,
})`;

let ui = null;
for (let attempt = 0; attempt < 25 && (ui?.wordmark == null || ui.canvasNodes === 0); attempt++) {
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
 * The Describe panel mounts and can be typed into.
 *
 * Deliberately stops short of pressing Build: this profile has no AI binding,
 * and `aec.brief_from_text` has no deterministic fallback, so a run here would
 * assert the failure path rather than the feature. What this guards is the
 * class of bug smoke exists for — a panel that renders nothing and says
 * nothing, the way the Inspector once did. The full text-to-model path is
 * covered by the graph's unit tests and by driving it against a mock provider.
 */
await evaluate(ws, 940, `document.querySelector('.tb-describe')?.click(), '"ok"'`);
await new Promise((r) => setTimeout(r, 600));
const chat = await evaluate(ws, 941, `JSON.stringify({
  dialog: !!document.querySelector('.chat-modal'),
  input: !!document.querySelector('.chat-input'),
  suggestions: document.querySelectorAll('.chat-suggestion').length,
  build: [...document.querySelectorAll('.chat-compose button')].some(b => /Build/.test(b.innerText)),
})`);
if (!chat?.dialog) fail('the Describe button did not open the design chat');
if (!chat.input || !chat.build) fail('the design chat opened without a composer — input:' + chat.input + ' build:' + chat.build);
if (chat.suggestions === 0) fail('the design chat offered no example descriptions, so an empty panel teaches nothing');
await evaluate(ws, 942, `document.querySelector('.chat-modal')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})), '"ok"'`);
await new Promise((r) => setTimeout(r, 400));
const chatClosed = await evaluate(ws, 943, `JSON.stringify(!document.querySelector('.chat-modal'))`);
if (chatClosed !== true) fail('Escape did not close the design chat');

/**
 * Binding an AI provider from its name, which is a WRITE all the way to disk.
 *
 * The AI panel's provider row is the one place the app creates a model profile
 * on a single click: it builds the profile, runs the validator, hands it to
 * main, main overwrites ai.yaml, and the panel re-reads the file rather than
 * trusting what it sent. Nothing below the renderer can exercise that — the
 * panel is reachable only through a native menu — and the failure mode is
 * silent, because a refused save leaves the click looking like it did nothing.
 * The fresh --user-data-dir means this writes a throwaway ai.yaml, never the
 * user's own.
 *
 * `openai-compatible` is deliberately NOT the provider clicked here: it has no
 * suggested model and requires an endpoint, so it opens the form instead, and
 * clicking it would test the fallback rather than the one-click path.
 */
await openSettingsTab('ai');
const aiBefore = await evaluate(ws, 980, `JSON.stringify({
  counter: document.querySelector('.settings-panel .settings-item-meta')?.innerText ?? null,
  rows: document.querySelectorAll('.settings-panel .settings-list-item').length,
  unbound: [...document.querySelectorAll('.ai-unbound button')].map(b => b.innerText),
  modelFields: document.querySelectorAll('.ai-key-line input:not([type=password])').length,
  keyFields: document.querySelectorAll('.ai-key-line input[type=password]').length,
})`);

if (!aiBefore?.unbound?.includes('OpenAI')) {
  fail(`the AI panel offers no OpenAI provider to bind; unbound: ${JSON.stringify(aiBefore?.unbound ?? [])}`);
}
// The row IS the editor, so each bound single-profile provider must carry an
// editable model field and (when it needs one) a key field. Zero of either
// means the fold swallowed the two settings that matter.
if ((aiBefore.modelFields ?? 0) === 0) fail('no editable model field on any provider row');
if ((aiBefore.keyFields ?? 0) === 0) fail('no key field on any provider row');

await evaluate(ws, 981, `[...document.querySelectorAll('.ai-unbound button')].find(b => b.innerText === 'OpenAI')?.click(), '"ok"'`);

let aiAfter = null;
for (let i = 0; i < 15 && (aiAfter?.rows ?? 0) <= (aiBefore.rows ?? 0); i++) {
  await new Promise((r) => setTimeout(r, 400));
  aiAfter = await evaluate(ws, 982 + i, `JSON.stringify({
    counter: document.querySelector('.settings-panel .settings-item-meta')?.innerText ?? null,
    rows: document.querySelectorAll('.settings-panel .settings-list-item').length,
    names: [...document.querySelectorAll('.settings-panel .settings-item-name')].map(e => e.innerText),
    errors: [...document.querySelectorAll('.settings-note--error')].map(e => e.innerText.slice(0, 200)),
  })`);
}
if (aiAfter?.errors?.length > 0) fail(`binding OpenAI reported an error: ${JSON.stringify(aiAfter.errors)}`);
if ((aiAfter?.rows ?? 0) !== aiBefore.rows + 1) {
  fail(`clicking OpenAI drew ${aiAfter?.rows ?? 0} provider rows, expected ${aiBefore.rows + 1} — the write was refused or never happened`);
}
if (!aiAfter.names.includes('OpenAI')) fail(`no OpenAI row after binding it; rows: ${JSON.stringify(aiAfter.names)}`);
// The counter is the anti-collapse tell-tale: it must count profiles AND
// providers, so a file with N bindings can never read as fewer.
if (!/3 profiles across 3 providers/.test(aiAfter.counter ?? '')) {
  fail(`the header counter says "${aiAfter.counter}" after adding a third profile`);
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

/**
 * The floor plan draws.
 *
 * The value behind it is 261,000 characters of JSON, and until there was a
 * `plan` preview the panel showed its leading 6% — so the assertion that
 * matters is not "something rendered" but "geometry rendered, in the quantity
 * the run actually produced". A fallback to the JSON preview would leave the
 * panel looking populated and this check failing, which is the point.
 */
await evaluate(ws, 890, `(() => {
  const node = [...document.querySelectorAll('.react-flow__node')]
    .find(n => /Generate Floor Plan/i.test(n.innerText));
  if (!node) return '"no-node"';
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  node.click();
  return '"ok"';
})()`);
await new Promise((r) => setTimeout(r, 600));

const plan = await evaluate(ws, 891, `JSON.stringify({
  svgs: document.querySelectorAll('.plan-svg').length,
  rooms: document.querySelectorAll('.plan-room').length,
  walls: document.querySelectorAll('.plan-wall').length,
  labels: document.querySelectorAll('.plan-label').length,
  caption: document.querySelector('.plan-caption')?.innerText ?? null,
  viewBox: document.querySelector('.plan-svg')?.getAttribute('viewBox') ?? null,
  json: document.querySelectorAll('.preview-pre').length,
})`);

if (plan?.svgs !== 1) fail(`the floor plan did not draw — ${plan?.svgs ?? 0} plan views, ${plan?.json ?? 0} raw JSON blocks instead`);
if (plan.rooms < 10) fail(`only ${plan.rooms} rooms drawn; the example's ground floor has 27`);
if (plan.walls < 10) fail(`only ${plan.walls} walls drawn`);
// Labels are the part that needed rotating to work at all: a corridor plan's
// rooms are deeper than they are wide, and requiring a horizontal fit labelled
// one room in twenty-seven.
if (plan.labels < 5) fail(`only ${plan.labels} room labels drawn — the fit test is rejecting rooms that should fit`);
// A viewBox of zero extent renders nothing while every element still exists.
const extent = (plan.viewBox ?? '').split(/\s+/).map(Number);
if (extent.length !== 4 || !(extent[2] > 0) || !(extent[3] > 0)) fail(`bad plan viewBox: ${plan.viewBox}`);

// Every storey the budget allows is carried, so the panel offers a switcher.
// The first version sent only the ground floor, which showed a sixth of a
// six-storey building and implied the rest did not exist.
const storeys = await evaluate(ws, 895, `JSON.stringify({
  buttons: document.querySelectorAll('.plan-storey').length,
  current: document.querySelector('.plan-storey.is-current')?.innerText ?? null,
  rooms: [...document.querySelectorAll('.plan-room title')].map(t => t.textContent).slice(0, 3),
})`);
if (storeys.buttons !== 6) fail(`expected a switcher for the example's 6 storeys; found ${storeys.buttons}`);

await evaluate(ws, 896, `[...document.querySelectorAll('.plan-storey')][3]?.click(), '"ok"'`);
await new Promise((r) => setTimeout(r, 500));
const switched = await evaluate(ws, 897, `JSON.stringify({
  current: document.querySelector('.plan-storey.is-current')?.innerText ?? null,
  caption: document.querySelector('.plan-caption')?.innerText ?? null,
  rooms: [...document.querySelectorAll('.plan-room title')].map(t => t.textContent).slice(0, 3),
})`);
if (switched.current !== '4') fail(`clicking storey 4 left "${switched.current}" selected`);
if (!/storey 4 of 6/.test(switched.caption ?? '')) fail(`the caption did not follow the switcher: ${switched.caption}`);
// The selection changing is not the same as the drawing changing — a switcher
// that highlights a button and redraws the same storey looks entirely correct.
if (JSON.stringify(switched.rooms) === JSON.stringify(storeys.rooms)) {
  fail(`storey 4 drew the same rooms as storey 1: ${JSON.stringify(switched.rooms)}`);
}

// The panel that holds it is resizable, because 216px of fixed height leaves
// about 130px for a drawing.
const beforeDrag = await evaluate(ws, 892, `JSON.stringify(document.querySelector('.exec-preview').clientHeight)`);
await evaluate(ws, 893, `(() => {
  const d = document.querySelector('.exec-divider');
  if (!d) return '"no-divider"';
  const r = d.getBoundingClientRect();
  const opts = { bubbles: true, pointerId: 1, clientY: r.top + 2 };
  d.setPointerCapture = () => {}; d.releasePointerCapture = () => {};
  d.dispatchEvent(new PointerEvent('pointerdown', opts));
  d.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientY: r.top - 200 }));
  d.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientY: r.top - 200 }));
  return '"ok"';
})()`);
await new Promise((r) => setTimeout(r, 400));
const afterDrag = await evaluate(ws, 894, `JSON.stringify({
  preview: document.querySelector('.exec-preview').clientHeight,
  stored: localStorage.getItem('archspace.execPanelHeight'),
})`);
if (afterDrag.preview <= beforeDrag) fail(`dragging the divider up did not grow the panel (${beforeDrag} -> ${afterDrag.preview})`);
// The persisted height must come from where the drag ended, not where it
// began: reading it from React state in the pointerup handler saved the
// starting value, so the panel resized and then reverted on next launch. The
// stored number is the whole panel and `preview` is its body, so they differ by
// the header — hence a tolerance rather than equality. What is being asserted
// is that it moved with the drag at all.
const startedFrom = 216;
if (Math.abs(Number(afterDrag.stored) - afterDrag.preview) > 80 || Number(afterDrag.stored) === startedFrom) {
  fail(`the divider persisted ${afterDrag.stored} for a panel of ${afterDrag.preview} — the saved height is stale`);
}

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

// Param promotion, clicked (ADR-0017). The DXF exporter is still the selected
// node, and `file_name` is one of the three first-party params opted in — so
// the inspector must be offering a promote button, pressing it must add an
// input port to the card, and pressing it again must take it away. Nothing in
// CI launches Electron, so this is the only place the affordance is exercised
// at all; the engine and CLI suites cover everything behind it.
const promoteBefore = await evaluate(ws, 930, `JSON.stringify({
  buttons: document.querySelectorAll('.promote-toggle').length,
  inPorts: document.querySelectorAll('.react-flow__node.selected .ports-in .port-row').length,
  promotedPorts: document.querySelectorAll('.react-flow__node.selected .port-row.port-promoted').length,
})`);
if ((promoteBefore?.buttons ?? 0) === 0) {
  fail('the inspector offers no promote button on aec.export_dxf — file_name is marked promotable, so the affordance is missing');
}
if (promoteBefore.promotedPorts !== 0) fail(`the exporter already has ${promoteBefore.promotedPorts} promoted ports before anything was clicked`);

await evaluate(ws, 931, `(() => {
  const label = [...document.querySelectorAll('.inspector .field-label')]
    .find(l => /file name/i.test(l.innerText));
  const button = label?.querySelector('.promote-toggle');
  if (!button) return '"no-button"';
  button.click();
  return '"ok"';
})()`);
await new Promise((r) => setTimeout(r, 500));

const promoteAfter = await evaluate(ws, 932, `JSON.stringify({
  inPorts: document.querySelectorAll('.react-flow__node.selected .ports-in .port-row').length,
  promotedPorts: document.querySelectorAll('.react-flow__node.selected .port-row.port-promoted').length,
  handles: document.querySelectorAll('.react-flow__node.selected .handle-promoted').length,
  dirty: document.title.includes('•') || undefined,
})`);
if (promoteAfter.promotedPorts !== 1) {
  fail(`promoting file_name drew ${promoteAfter.promotedPorts} promoted ports, expected 1`);
}
if (promoteAfter.inPorts !== promoteBefore.inPorts + 1) {
  fail(`the card gained ${promoteAfter.inPorts - promoteBefore.inPorts} input ports, expected exactly 1`);
}
if (promoteAfter.handles !== 1) fail(`the promoted port drew ${promoteAfter.handles} connectable handles, expected 1`);

// And back: demotion is the half that deletes state, so it is the half worth
// checking twice.
await evaluate(ws, 933, `(() => {
  const label = [...document.querySelectorAll('.inspector .field-label')]
    .find(l => /file name/i.test(l.innerText));
  label?.querySelector('.promote-toggle')?.click();
  return '"ok"';
})()`);
await new Promise((r) => setTimeout(r, 500));
const demoted = await evaluate(ws, 934, `JSON.stringify({
  inPorts: document.querySelectorAll('.react-flow__node.selected .ports-in .port-row').length,
  promotedPorts: document.querySelectorAll('.react-flow__node.selected .port-row.port-promoted').length,
})`);
if (demoted.promotedPorts !== 0 || demoted.inPorts !== promoteBefore.inPorts) {
  fail(`demoting left ${demoted.promotedPorts} promoted ports and ${demoted.inPorts} inputs (started at ${promoteBefore.inPorts})`);
}

/**
 * The 3D model draws (ADR-0003).
 *
 * The chain under test spans all three processes and is exercised nowhere
 * else: readAsset over the preload bridge, main's asset:read handler, the
 * engine's control-channel byte read, the inlined wasm booting under this
 * window's origin, and web-ifc parsing the run's actual IFC. Assertions are
 * DOM facts derived from parsed geometry, never pixels — a caption that says
 * "636 walls" can only come from a parse that found them. The caption's
 * numbers are cross-checked against the summary port's JSON preview in the
 * same panel: the writer's bookkeeping and an independent parser reading the
 * file, agreeing in front of the user. Equality holds because the example
 * has no degenerate products; the unit suite covers where the two counts
 * legitimately diverge.
 */
await evaluate(ws, 950, `(() => {
  const node = [...document.querySelectorAll('.react-flow__node')]
    .find(n => /Generate BIM Model/i.test(n.innerText));
  if (!node) return '"no-node"';
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  node.click();
  return '"ok"';
})()`);

let ifc = null;
for (let i = 0; i < 20 && !ifc?.settled; i++) {
  await new Promise((r) => setTimeout(r, 500));
  ifc = await evaluate(ws, 951 + i, `JSON.stringify({
    settled: !!document.querySelector('.ifc-caption') || !!document.querySelector('.ifc-error'),
    error: document.querySelector('.ifc-error')?.innerText ?? null,
    caption: document.querySelector('.ifc-caption')?.innerText ?? null,
    canvasW: document.querySelector('.ifc-canvas canvas')?.clientWidth ?? 0,
    canvasH: document.querySelector('.ifc-canvas canvas')?.clientHeight ?? 0,
    storeyButtons: document.querySelectorAll('.ifc-storeys .ifc-storey').length,
    bridge: typeof window.archspace?.readAsset,
    summary: [...document.querySelectorAll('.preview-pre')].map(e => e.innerText).join('\\n').slice(0, 4000),
  })`);
}
if (ifc?.bridge !== 'function') fail(`window.archspace.readAsset is ${ifc?.bridge} — the preload bridge does not expose it`);
if (!ifc?.settled) fail('the 3D viewer reported neither a model nor an error — the readAsset round trip or the wasm boot never returned');
if (ifc.error) fail(`the 3D viewer errored in-app: ${ifc.error}`);
const counted = /(\d+) walls · (\d+) doors · (\d+) spaces/.exec(ifc.caption ?? '');
if (!counted) fail(`the viewer caption is not counting geometry: ${ifc.caption}`);
for (const [entity, drawn] of [['IfcWall', counted[1]], ['IfcDoor', counted[2]], ['IfcSpace', counted[3]]]) {
  const recorded = new RegExp(`"${entity}":\\s*(\\d+)`).exec(ifc.summary ?? '');
  if (!recorded) fail(`the summary preview shows no ${entity} count to check the viewer against`);
  if (recorded[1] !== drawn) {
    fail(`the viewer drew ${drawn} ${entity} but the writer recorded ${recorded[1]} — parser and writer disagree`);
  }
}
if (!(ifc.canvasW > 0 && ifc.canvasH > 0)) fail(`the viewer canvas is ${ifc.canvasW}x${ifc.canvasH} — nothing is on screen`);
if (ifc.storeyButtons !== 7) fail(`expected All + 6 storey buttons on the viewer; found ${ifc.storeyButtons}`);

// Isolating a storey must register. The geometry change itself is mesh
// visibility on the GPU, but the state driving it is this DOM toggle.
await evaluate(ws, 972, `[...document.querySelectorAll('.ifc-storeys .ifc-storey')][3]?.click(), '"ok"'`);
await new Promise((r) => setTimeout(r, 300));
const isolated = await evaluate(ws, 973, `JSON.stringify({
  current: document.querySelector('.ifc-storeys .ifc-storey.is-current')?.innerText ?? null,
})`);
if (isolated?.current !== '3') fail(`clicking viewer storey 3 left "${isolated?.current}" selected`);

// A file dropped on the canvas must not take the window with it.
//
// `onDragOver` calls `preventDefault` for every drag so the palette can drop
// here, which makes the canvas a drop target for *everything* — and a drop the
// handler declines still runs the browser default, which for a file is to
// navigate to it. The app was then a `file://` listing with no way back short
// of quitting, and nothing in CI launches Electron to notice.
//
// Two assertions, because they cover different halves. The first is the
// renderer's: a synthetic drop is untrusted and performs no default action, so
// what is checked is the mechanism — `dispatchEvent` returns false only if the
// handler cancelled it, and the handler must cancel a drop it does not want.
// The second is the main process's backstop, and it is a real navigation: a
// `will-navigate` that did not fire would leave `location.href` somewhere else.
const drop = await evaluate(ws, 910, `JSON.stringify((() => {
  // The pane, not '.canvas-wrap': onDrop is on the ReactFlow element, which is
  // a CHILD of the wrapper, so an event dispatched on the wrapper bubbles the
  // wrong way and never reaches the handler under test.
  const target = document.querySelector('.react-flow__pane') ?? document.querySelector('.react-flow');
  if (!target) return { error: 'no react-flow pane' };
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'dropped.txt', { type: 'text/plain' }));
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  return {
    overCancelled: !target.dispatchEvent(over),
    dropCancelled: !target.dispatchEvent(dropped),
    nodes: document.querySelectorAll('.react-flow__node').length,
  };
})())`);
if (drop?.error) fail(`could not reach the canvas to test the drop: ${drop.error}`);
if (!drop.dropCancelled) {
  fail('the canvas let a dropped file keep its default action \u2014 in a real drop that navigates the window away from the app');
}
if (drop.nodes !== ui.canvasNodes) {
  fail(`dropping a file changed the graph (${ui.canvasNodes} -> ${drop.nodes} nodes)`);
}

// ...but it must still be allowed to reload ITSELF. `will-navigate` fires for a
// renderer-initiated reload, so a blanket `preventDefault` refuses the very
// thing Vite does when HMR cannot patch a change — `pnpm dev` stops picking up
// edits and looks like a broken build. Asserted here because that failure is
// invisible to every other gate: production never reloads.
//
// A marker on `window`, because "the app is still rendered" cannot tell a
// successful reload from a REFUSED one — the old page is still there either
// way. Only something that a fresh document would not have distinguishes them.
const beforeReload = await evaluate(ws, 906, `(() => {
  window.__smokeReloadMarker = 'set-before-reload';
  return JSON.stringify({ href: location.href, marker: window.__smokeReloadMarker });
})()`);
await evaluate(ws, 907, `(() => { location.reload(); return '"asked"'; })()`);
await new Promise((r) => setTimeout(r, 3000));
const afterReload = await evaluate(ws, 908, `JSON.stringify({
  href: location.href,
  marker: window.__smokeReloadMarker ?? null,
  mounted: !!document.querySelector('.react-flow'),
})`);
if (afterReload?.href !== beforeReload?.href) {
  fail(`a reload changed the URL: ${beforeReload?.href} -> ${afterReload?.href}`);
}
if (afterReload?.marker !== null) {
  fail('the page never actually reloaded — the marker from before it survived, so the navigation guard refused its own document');
}
if (afterReload?.mounted !== true) {
  fail('the window reloaded and did not come back');
}

const hrefBefore = await evaluate(ws, 911, 'JSON.stringify(location.href)');
await evaluate(ws, 912, `(() => { location.href = 'https://example.com/'; return '"asked"'; })()`);
await new Promise((r) => setTimeout(r, 700));
const hrefAfter = await evaluate(ws, 913, 'JSON.stringify(location.href)');
if (hrefAfter !== hrefBefore) {
  fail(`the window navigated away: ${hrefBefore} -> ${hrefAfter} \u2014 main's will-navigate guard did not hold`);
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
    `       AI provider bound in one click — ${aiBefore.rows} rows -> ${aiAfter.rows}, "${aiAfter.counter}", written through to ai.yaml and read back\n` +
    `       design chat opens — composer, ${chat.suggestions} example descriptions, closes on Escape\n` +
    `       ${(run.final ?? '').trim()}\n` +
    `       floor plan drew — ${plan.rooms} rooms, ${plan.walls} walls, ${plan.labels} labels\n` +
    `       storey switcher — ${storeys.buttons} storeys, switching to 4 redrew the plan; panel resized ${beforeDrag} -> ${afterDrag.preview}px\n` +
    `       saved through the UI — clicked Save on the DXF exporter, ${savedBytes.byteLength} bytes of valid R12 landed on disk\n` +
    `       refused to navigate \u2014 a dropped file was cancelled and a scripted location change did not leave ${hrefBefore}\n` +
    `       promotion clicked \u2014 ${promoteBefore.buttons} promotable param${promoteBefore.buttons === 1 ? '' : 's'} offered; promoting file_name took the exporter ${promoteBefore.inPorts} \u2192 ${promoteAfter.inPorts} input ports, demoting put it back\n` +
    `       3D model drew \u2014 ${counted[1]} walls / ${counted[2]} doors / ${counted[3]} spaces matched the writer's summary; storey filter live on a ${ifc.canvasW}x${ifc.canvasH} canvas\n` +
    `       reloaded itself and came back \u2014 the navigation guard refuses other documents, not its own`,
);
