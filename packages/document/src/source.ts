import type { Document } from 'yaml';

/**
 * Opaque handle wrapping the parsed YAML document (the comment-preserving
 * CST from the yaml package's document API). Returned by `parseWorkflow`,
 * held by callers between open and save, consumed and updated by
 * `saveWorkflow`. Treat it as a black box — the fields are internal to
 * @archspace/document.
 */
export class WorkflowSource {
  /** @internal The live yaml Document; saveWorkflow patches it in place. */
  ydoc: Document;
  /** @internal The exact text this handle currently corresponds to. */
  text: string;

  /** @internal */
  constructor(ydoc: Document, text: string) {
    this.ydoc = ydoc;
    this.text = text;
  }
}
