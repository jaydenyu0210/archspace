/** BIM model: asset metadata, IFC text validity, GUID mapping. */
import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@archspace/node-sdk';
import type { BimModelSummary, FloorPlanResult } from '../src/index.js';
import { runPipeline, type PipelineRun } from './helpers.js';

const GUID_RE = /^[0-9A-Za-z_$]{22}$/;

async function ifcText(run: PipelineRun): Promise<string> {
  const ref = run.bim.outputs.model as AssetRef;
  return new TextDecoder().decode(await run.assets.bytes(ref));
}

describe('aec.generate_bim_model', () => {
  it('stores an asset<ifc> ref with model/ifc media type', async () => {
    const run = await runPipeline();
    const ref = run.bim.outputs.model as AssetRef;
    expect(ref.kind).toBe('asset');
    expect(ref.mediaType).toBe('model/ifc');
    expect(ref.format).toBe('ifc');
    expect(ref.name).toMatch(/^plan_[0-9a-f]{8}\.ifc$/);
  });

  it('writes syntactically plausible SPF with the right entity counts', async () => {
    const run = await runPipeline();
    const text = await ifcText(run);
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;

    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'))");
    expect(text).toContain('END-ISO-10303-21;');

    const storeys = text.match(/=IFCBUILDINGSTOREY\(/g)?.length ?? 0;
    expect(storeys).toBe(plan.levels.length);

    const totalRooms = plan.levels.reduce((s, l) => s + l.rooms.length, 0);
    const spaces = text.match(/=IFCSPACE\(/g)?.length ?? 0;
    expect(spaces).toBe(totalRooms);
  });

  it('uses unique #n= entity ids', async () => {
    const run = await runPipeline();
    const text = await ifcText(run);
    const ids = [...text.matchAll(/^#(\d+)=/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps every room id to a unique 22-char IFC guid in the summary', async () => {
    const run = await runPipeline();
    const plan = run.plan.outputs.floor_plan as unknown as FloorPlanResult;
    const summary = run.bim.outputs.summary as unknown as BimModelSummary;

    expect(summary.schema).toBe('IFC4');
    expect(summary.storeys).toBe(plan.levels.length);

    const guidByRoom = new Map(summary.spaces.map((s) => [s.roomId, s.guid]));
    for (const level of plan.levels) {
      for (const room of level.rooms) {
        const guid = guidByRoom.get(room.id);
        expect(guid, `guid for ${room.id}`).toBeDefined();
        expect(guid).toMatch(GUID_RE);
      }
    }
    for (const door of summary.doors) expect(door.guid).toMatch(GUID_RE);

    const allGuids = [...summary.spaces.map((s) => s.guid), ...summary.doors.map((d) => d.guid)];
    expect(new Set(allGuids).size).toBe(allGuids.length);
  });
});
