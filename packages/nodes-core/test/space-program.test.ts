/** Space program derivation: area accounting, efficiency, level assignment. */
import { describe, expect, it } from 'vitest';
import type { SpaceProgramSummary, TableValue } from '../src/index.js';
import { runPipeline } from './helpers.js';

describe('aec.space_program', () => {
  it('room areas sum to the net area within 1%', async () => {
    const { program } = await runPipeline();
    const table = program.outputs.program as unknown as TableValue;
    const summary = program.outputs.summary as unknown as SpaceProgramSummary;
    const net = summary.grossAreaM2 * (1 - 0.35);
    const sum = table.rows.reduce((s, r) => s + (r.area_m2 as number), 0);
    expect(summary.grossAreaM2).toBeGreaterThan(0);
    expect(Math.abs(sum - net) / net).toBeLessThan(0.01);
  });

  it('efficiency equals 1 − circulation_factor within 0.01', async () => {
    const { program } = await runPipeline({ program: { circulation_factor: 0.4 } });
    const summary = program.outputs.summary as unknown as SpaceProgramSummary;
    expect(Math.abs(summary.efficiency - (1 - 0.4))).toBeLessThan(0.01);
  });

  it('all rows have positive areas and levels below the floor count', async () => {
    const { program } = await runPipeline();
    const table = program.outputs.program as unknown as TableValue;
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(row.area_m2 as number).toBeGreaterThan(0);
      expect(row.level as number).toBeGreaterThanOrEqual(0);
      expect(row.level as number).toBeLessThan(6);
      expect(row.occupant_load as number).toBeGreaterThan(0);
      expect(row.space_id).toMatch(/^sp_\d{3,}$/);
    }
  });

  it('every building type has a template whose areas still sum to net', async () => {
    for (const buildingType of ['office', 'residential', 'school', 'mixed_use']) {
      const { program } = await runPipeline({ brief: { building_type: buildingType } });
      const table = program.outputs.program as unknown as TableValue;
      const summary = program.outputs.summary as unknown as SpaceProgramSummary;
      const net = summary.grossAreaM2 * (1 - 0.35);
      const sum = table.rows.reduce((s, r) => s + (r.area_m2 as number), 0);
      expect(Math.abs(sum - net) / net, buildingType).toBeLessThan(0.01);
      expect(summary.spaceCount).toBe(table.rows.length);
      expect(summary.perLevel).toHaveLength(6);
    }
  });
});
