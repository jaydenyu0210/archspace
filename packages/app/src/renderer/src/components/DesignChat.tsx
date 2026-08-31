/**
 * Describe a building, get a model. The canvas without the canvas.
 *
 * Everything else in this app is a graph you wire. That is the product, and it
 * is the right shape for work you repeat — but it is the wrong shape for the
 * first five minutes, where "a four-storey library on a 40 by 30 m plot" meant
 * dragging four nodes and drawing four wires that were the same four every
 * time. This panel is those four nodes with the wiring already done: a text
 * box, a transcript, and the model that came back.
 *
 * **It is not a second engine.** `buildChatGraph` produces an ordinary
 * `EngineGraph` and `startGraphRun` sends it down the same MessagePort the
 * canvas uses, so a chat turn is a workflow run in every respect the engine
 * can see — same validation, same events, same asset store, same one-run-at-a-
 * time rule. Nothing here re-implements execution, and nothing here can
 * produce a model the canvas could not.
 *
 * **Why a transcript and not a form.** Each turn keeps its own description and
 * its own model, so two descriptions can be compared side by side by scrolling
 * rather than by remembering. That is the one thing a chat shape buys over a
 * single input box, and it is why the turns are kept after they finish.
 *
 * **What it does not do.** There is no conversation: each turn is independent
 * and the model is not told what came before, because the node it drives takes
 * a description and nothing else. Calling that a chat would be a claim this
 * panel has not paid for, so the placeholder asks for a description rather
 * than inviting a reply, and a turn that failed says so rather than answering.
 */
import { useEffect, useRef, useState } from 'react';
import type { AssetRef } from '@archspace/node-sdk';
import { useStore } from '../store';
import { startGraphRun } from '../engine-client';
import { BIM_NODE, buildChatGraph, describeModel } from '../chat-graph';
import { IfcView } from './IfcView';

/** One exchange: what was asked for, and how it turned out. */
interface Turn {
  id: number;
  description: string;
  runId: string;
  state: 'running' | 'done' | 'failed';
  /** The IFC, once the BIM node has produced one. */
  model?: AssetRef;
  /** A line about what was built, from the writer's own summary. */
  summary?: string;
  error?: string;
}

export function DesignChat({ onClose }: { onClose: () => void }) {
  const engineReady = useStore((s) => s.engineReady);
  const run = useStore((s) => s.run);
  const notify = useStore((s) => s.notify);

  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the newest turn in view as it grows, the way a log does.
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns]);

  /**
   * Fold the store's run state into whichever turn is waiting on it.
   *
   * The store holds ONE run — the engine's own notion (§7.6) — so this reads
   * the run it started by id and ignores anything else, which is what lets a
   * canvas run and a chat turn coexist without either claiming the other's
   * result.
   */
  useEffect(() => {
    setTurns((current) =>
      current.map((turn) => {
        if (turn.state !== 'running' || turn.runId !== run.runId) return turn;
        if (run.running) return turn;

        const previews = run.previews[BIM_NODE] ?? [];
        const model = previews.find((p) => p.port === 'model');
        const summary = previews.find((p) => p.port === 'summary');
        if (model?.preview.kind === 'asset') {
          return {
            ...turn,
            state: 'done',
            model: model.preview.ref,
            ...(summary?.preview.kind === 'json'
              ? { summary: describeModel(safeParse(summary.preview.json)) ?? undefined }
              : {}),
          };
        }
        // No asset means the chain stopped somewhere. The engine already said
        // where, in the words of whichever node failed; the first of those is
        // more useful than a summary this panel could invent.
        return { ...turn, state: 'failed', error: firstFailure(run) };
      }),
    );
  }, [run]);

  const submit = (): void => {
    const description = draft.trim();
    if (description === '') return;
    if (!engineReady) {
      notify('warn', 'The engine is not connected yet.');
      return;
    }
    const runId = startGraphRun(buildChatGraph(description));
    if (runId === null) {
      notify('warn', 'A run is already going — wait for it to finish.');
      return;
    }
    setTurns((t) => [...t, { id: nextId.current++, description, runId, state: 'running' }]);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    // Enter sends; Shift+Enter is a newline. A description is often two
    // sentences, so the newline has to stay reachable.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const busy = turns.some((t) => t.state === 'running');

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-title" onKeyDown={onKeyDown}>
        <header className="settings-head">
          <h2 className="settings-title" id="chat-title">
            Describe a building
          </h2>
          <span className="settings-subtitle">Text in, an IFC model out</span>
          <div className="settings-head-spacer" />
          <button className="settings-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="chat-transcript" ref={transcriptRef}>
          {turns.length === 0 && (
            <div className="chat-empty">
              <p className="settings-section-desc">
                Say what you want built — the site, the storeys, roughly how much area, and anything
                that matters about how it is used. A brief, a plan and an IFC model are produced
                from it; you never have to wire them up.
              </p>
              <div className="chat-suggestions">
                {[
                  'A four-storey neighbourhood library on a 40 by 30 m corner plot, around 3,000 m², with a reading room facing the street.',
                  'A six-storey speculative office on a 48 by 32 m riverside plot, about 7,500 m², open-plan floors.',
                  'A single-storey primary school on a 60 by 40 m site, 1,900 m², classrooms off a daylit spine.',
                ].map((example) => (
                  <button
                    key={example}
                    className="settings-btn settings-btn--small chat-suggestion"
                    onClick={() => setDraft(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className="chat-turn">
              <div className="chat-said">{turn.description}</div>
              <div className="chat-reply">
                {turn.state === 'running' && (
                  <div className="settings-loading">
                    <span className="settings-spinner" />{' '}
                    {run.events.length > 0
                      ? (lastProgress(run) ?? 'Working…')
                      : 'Working…'}
                  </div>
                )}
                {turn.state === 'failed' && (
                  <div className="settings-note settings-note--error">
                    {turn.error ?? 'The run did not produce a model.'}
                  </div>
                )}
                {turn.state === 'done' && turn.model !== undefined && (
                  <>
                    <div className="chat-model-head">
                      <span className="settings-item-name">{turn.model.name ?? 'model.ifc'}</span>
                      <span className="settings-item-meta">
                        {turn.summary ?? `${(turn.model.size / 1024).toFixed(0)} KB`}
                      </span>
                      <div className="settings-item-actions">
                        <SaveModel asset={turn.model} />
                      </div>
                    </div>
                    <IfcView asset={turn.model} />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="chat-compose">
          <textarea
            ref={inputRef}
            className="settings-input chat-input"
            rows={3}
            value={draft}
            placeholder="A four-storey library on a 40 by 30 m plot, around 3,000 m²…"
            spellCheck
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className="settings-btn settings-btn--primary"
            disabled={draft.trim() === '' || busy || !engineReady}
            title={engineReady ? 'Build it (Enter)' : 'The engine is not connected'}
            onClick={submit}
          >
            {busy ? 'Building…' : 'Build'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Save, reusing the bridge the execution panel's asset card uses. */
function SaveModel({ asset }: { asset: AssetRef }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  return (
    <button
      className="settings-btn settings-btn--small"
      disabled={state === 'saving'}
      onClick={() => {
        setState('saving');
        void window.archspace
          .saveAsset(asset)
          .then((r) => setState(r.ok ? 'saved' : 'idle'))
          .catch(() => setState('error'));
      }}
    >
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save IFC…'}
    </button>
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The newest progress message, so a wait says what it is waiting on. */
function lastProgress(run: { events: { type: string; message?: string }[] }): string | null {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const event = run.events[i];
    if (event.type === 'node:progress' && typeof event.message === 'string') return event.message;
  }
  return null;
}

/**
 * Why a turn produced nothing, in the failing node's own words.
 *
 * Deliberately the engine's message rather than a sentence composed here: the
 * nodes already explain themselves well ("no AI model profile is bound",
 * "40000 m² does not fit 6 floor(s) on a 1536 m² site"), and a chat that
 * replaced those with "something went wrong" would be throwing away the only
 * part a user can act on.
 */
function firstFailure(run: { events: { type: string; message?: string }[] }): string {
  for (const event of run.events) {
    if (event.type === 'node:failed' && typeof event.message === 'string') return event.message;
  }
  return 'The run finished without producing a model.';
}
