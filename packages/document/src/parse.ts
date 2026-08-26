/**
 * Text → `WorkflowDoc`, and the CST that produced it (ARCHITECTURE §4 /
 * ADR-0004).
 *
 * `parseWorkflow` hands back a `WorkflowSource` alongside the document, and
 * that pairing is the reason this package is not a call to `YAML.parse`.
 * ADR-0004 decision 4 requires that saving preserve the comments, key order
 * and quoting a human wrote, and only the original CST knows them — so the
 * parse keeps it and `saveWorkflow` patches it. Parsing to a plain object and
 * re-emitting was the alternative: it is a fraction of the code and it deletes
 * every comment in the user's file the first time they press save.
 *
 * Loading is resilient (§4): a parser error is fatal, everything else is a
 * warning that still yields a usable document. `extractWorkflow` owns that
 * split — see its comment for the exact list, which is normative.
 */
import { isMap, isSeq, parseDocument, type Document } from 'yaml';
import type { DocIssue, ParseWorkflowResult } from './types.js';
import { extractWorkflow } from './extract.js';
import { WorkflowSource } from './source.js';
import { UnpaddedFlowSeq, findPair } from './yaml-util.js';

/**
 * Parse a workflow document (YAML 1.2, core schema — no implicit-typing
 * surprises; "true", "007", "null" only mean the scalar they spell when
 * quoted). Resilient: warnings still load, only structural damage is fatal
 * (see extractWorkflow). On success the returned WorkflowSource wraps the
 * comment-preserving yaml Document so a later saveWorkflow can patch it
 * instead of re-emitting.
 */
export function parseWorkflow(text: string): ParseWorkflowResult {
  const ydoc = parseDocument(text, { version: '1.2' });
  if (ydoc.errors.length > 0) {
    const issues: DocIssue[] = ydoc.errors.map((e) => ({
      severity: 'error' as const,
      message: e.message,
    }));
    return { ok: false, issues };
  }
  const parserWarnings: DocIssue[] = ydoc.warnings.map((w) => ({
    severity: 'warning' as const,
    message: w.message,
  }));
  const { doc, issues } = extractWorkflow(ydoc);
  const all = [...parserWarnings, ...issues];
  if (doc === null) return { ok: false, issues: all };
  adoptCanonicalStyles(ydoc);
  return { ok: true, doc, source: new WorkflowSource(ydoc, text), issues: all };
}

/**
 * Re-tag the requires lists so they stringify unpadded (`[revit]`) while
 * other flow collections keep the default padding (`{ x: 120, y: 240 }`).
 * A stringify-style adjustment only; the document content is untouched.
 */
function adoptCanonicalStyles(ydoc: Document): void {
  const root = ydoc.contents;
  if (!isMap(root)) return;
  const req = findPair(root, 'requires');
  if (req !== undefined && isMap(req.value)) {
    for (const p of req.value.items) {
      if (isSeq(p.value) && !(p.value instanceof UnpaddedFlowSeq)) {
        Object.setPrototypeOf(p.value, UnpaddedFlowSeq.prototype);
      }
    }
  }
}
