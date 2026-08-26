/** Floor plan geometry, doors, exits, capacity failure, and progress. */
import { describe, expect, it } from 'vitest';
import type { FloorPlanResult, PlanRoom } from '../src/index.js';
import { runPipeline } from './helpers.js';

function bounds(room: PlanRoom): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function overlaps(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

describe('aec.generate_floor_plan', () => {
  it('rooms never overlap the corridor and every non-corridor room has a door', async () => {
    const { plan } = await runPipeline();
    const result = plan.outputs.floor_plan as unknown as FloorPlanResult;
    expect(result.levels.length).toBe(6);
    for (const level of result.levels) {
      const corridor = level.rooms.find((r) => r.function === 'circulation');
      expect(corridor, `level ${level.level} has a corridor`).toBeDefined();
      const corridorBox = bounds(corridor!);
      const doorRooms = new Set(level.doors.map((d) => d.roomId));
      for (const room of level.rooms) {
        if (room.function === 'circulation') continue;
        expect(overlaps(bounds(room), corridorBox), `${room.id} overlaps corridor`).toBe(false);
        expect(doorRooms.has(room.id), `${room.id} has a door`).toBe(true);
      }
    }
  });

  it('provides at least two exits per level when floors > 1', async () => {
    const { plan } = await runPipeline();
    const result = plan.outputs.floor_plan as unknown as FloorPlanResult;
    for (const level of result.levels) {
      expect(level.exits.length).toBeGreaterThanOrEqual(2);
      expect(level.exits.every((x) => x.kind === 'stair')).toBe(true);
    }
  });

  it('throws the capacity error naming target and usable areas', async () => {
    // usable = floors × siteArea × 0.85 = 6 × 1536 × 0.85
    const usable = Math.round(6 * 1536 * 0.85 * 100) / 100;
    let message = '';
    try {
      await runPipeline({ brief: { target_gross_area_m2: 20000 } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).toContain('20000');
    expect(message).toContain(String(usable));
  });

  it('emits progress events during generation', async () => {
    const { plan } = await runPipeline();
    expect(plan.progress.length).toBeGreaterThan(1);
    expect(plan.progress.some((p) => p.fraction === 1)).toBe(true);
  });
});
