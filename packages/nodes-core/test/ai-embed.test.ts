/**
 * ai.embed: the index correspondence between what went in and what came out,
 * which is the whole contract — every downstream use of an embedding set reads
 * row i of a table against vector i, so a silent misalignment is worse than a
 * failure. `ctx.ai` is scripted rather than real: ADR-0013 keeps live provider
 * calls out of the blocking lanes, and nodes-core deliberately cannot see the
 * gateway (ADR-0010) so there is nothing else here to reach for.
 */
import { describe, expect, it } from 'vitest';
import { runNode } from '@archspace/node-sdk/testkit';
import { isValueOfType } from '@archspace/types';
import type { AiGateway, Value } from '@archspace/node-sdk';
import { aiEmbedNode } from '../src/ai-embed.js';

/** Records what the node asked for, and answers with vectors it can check. */
function recordingEmbed(dimensions = 4): {
  embed: AiGateway['embed'];
  calls: { profile?: string; values: string[] }[];
} {
  const calls: { profile?: string; values: string[] }[] = [];
  const embed: AiGateway['embed'] = async (req) => {
    calls.push({ ...(req.profile !== undefined ? { profile: req.profile } : {}), values: [...req.values] });
    // Vector i encodes i and the value's length, so a reordering or an
    // off-by-one in the node is visible in the assertion rather than hidden
    // behind vectors that all look alike.
    return {
      embeddings: req.values.map((value, index) =>
        Array.from({ length: dimensions }, (_, d) => index * 100 + d + value.length / 1000),
      ),
    };
  };
  return { embed, calls };
}

describe('ai.embed', () => {
  it('embeds a wired list in one call and every output matches its declared port type', async () => {
    const { embed, calls } = recordingEmbed();
    const run = await runNode(aiEmbedNode, {
      inputs: { values: ['a room', 'a corridor', 'a stair'] },
      ai: { embed },
    });

    // One request for the batch is the reason this node takes a list at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['a room', 'a corridor', 'a stair']);

    for (const port of aiEmbedNode.manifest.outputs) {
      expect(isValueOfType(run.outputs[port.id], port.type), `${port.id}: ${port.type}`).toBe(true);
    }
    expect(run.outputs.count).toBe(3);
    expect(run.outputs.dimensions).toBe(4);

    const embeddings = run.outputs.embeddings as unknown as number[][];
    expect(embeddings).toHaveLength(3);
    // Index correspondence: vector i is still the vector minted for value i.
    expect(embeddings[0]![0]).toBeCloseTo(0 + 'a room'.length / 1000);
    expect(embeddings[1]![0]).toBeCloseTo(100 + 'a corridor'.length / 1000);
    expect(embeddings[2]![0]).toBeCloseTo(200 + 'a stair'.length / 1000);
  });

  it('falls back to the text param when nothing is wired', async () => {
    const { embed, calls } = recordingEmbed();
    const run = await runNode(aiEmbedNode, {
      params: { text: '  a naturally lit meeting room  ' },
      ai: { embed },
    });

    // Trimmed, and sent as a one-element batch.
    expect(calls[0]!.values).toEqual(['a naturally lit meeting room']);
    expect(run.outputs.count).toBe(1);
  });

  it('ignores the text param when the port is wired, rather than merging them', async () => {
    const { embed, calls } = recordingEmbed();
    const run = await runNode(aiEmbedNode, {
      inputs: { values: ['wired one', 'wired two'] },
      params: { text: 'a literal that must not be appended' },
      ai: { embed },
    });

    // Merging would shift every index in the wired list by one, which is the
    // one thing a caller embedding a list cannot tolerate.
    expect(calls[0]!.values).toEqual(['wired one', 'wired two']);
    expect(run.outputs.count).toBe(2);
  });

  it('passes the requested profile through, and omits it when the field is empty', async () => {
    const named = recordingEmbed();
    await runNode(aiEmbedNode, {
      inputs: { values: ['x'] },
      params: { profile: 'work' },
      ai: { embed: named.embed },
    });
    expect(named.calls[0]!.profile).toBe('work');

    const blank = recordingEmbed();
    await runNode(aiEmbedNode, {
      inputs: { values: ['x'] },
      params: { profile: '   ' },
      ai: { embed: blank.embed },
    });
    // Absent, not the literal string "default": an empty field means "you
    // choose", and a user may well have made `work` their default.
    expect(blank.calls[0]!.profile).toBeUndefined();
  });

  it('stringifies a non-string element rather than handing it to the provider raw', async () => {
    const { embed, calls } = recordingEmbed();
    // A `json` widening upstream can put a number in a list<text> port; a
    // provider would answer that with a 400 that never mentions this node.
    const values: Value = ['a room', 42, { area: 12 }];
    await runNode(aiEmbedNode, { inputs: { values }, ai: { embed } });

    expect(calls[0]!.values).toEqual(['a room', '42', '{"area":12}']);
  });

  it('refuses to run with nothing to embed', async () => {
    const { embed, calls } = recordingEmbed();
    await expect(runNode(aiEmbedNode, { ai: { embed } })).rejects.toThrow(/nothing to embed/);
    // And it never spent a request finding that out.
    expect(calls).toHaveLength(0);
  });

  it('fails loudly when the provider returns a different number of vectors', async () => {
    const embed: AiGateway['embed'] = async () => ({ embeddings: [[1, 2, 3]] });
    await expect(
      runNode(aiEmbedNode, { inputs: { values: ['one', 'two'] }, ai: { embed } }),
    ).rejects.toThrow(/would not line up/);
  });

  it('is registered, and is the ai.embed type ARCHITECTURE §16 M4 names', async () => {
    const { registerCoreNodes, coreNodeTypes } = await import('../src/index.js');
    const { createNodeRegistry } = await import('@archspace/node-sdk');
    const registry = createNodeRegistry();
    registerCoreNodes(registry);

    expect(coreNodeTypes()).toContain('ai.embed');
    expect(registry.has('ai.embed')).toBe(true);
  });
});
