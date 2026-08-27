/**
 * The save dialog's filters.
 *
 * A filter is a claim about what a file is, made to the OS file picker. Get it
 * wrong in the strict direction — offer only `.dxf` for a file that is not one
 * — and the user cannot save their own output, which is the one failure this
 * whole feature exists to remove. So the case that matters most here is the
 * escape hatch: "All files" is always present.
 */
import { describe, expect, it } from 'vitest';
import { assetFilters } from '../src/main/asset-naming.js';

describe('assetFilters', () => {
  it('offers the asset’s own type first, named the way an architect would say it', () => {
    expect(assetFilters('tower.dxf')).toEqual([
      { name: 'AutoCAD DXF drawing', extensions: ['dxf'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    expect(assetFilters('plan.ifc')[0]).toEqual({ name: 'IFC model', extensions: ['ifc'] });
    expect(assetFilters('rooms.csv')[0]).toEqual({ name: 'CSV table', extensions: ['csv'] });
  });

  it('always leaves a way to save anyway', () => {
    // The filter is derived from a media type a node supplied. A wrong guess
    // must never be the reason someone cannot write their own file.
    for (const name of ['tower.dxf', 'thing.weird', 'noextension', '', 'a.b.c.xyz']) {
      const filters = assetFilters(name);
      expect(filters.at(-1), name).toEqual({ name: 'All files', extensions: ['*'] });
    }
  });

  it('falls back to the bare extension for a format it has no name for', () => {
    expect(assetFilters('thing.rvt')[0]).toEqual({ name: 'RVT', extensions: ['rvt'] });
    expect(assetFilters('CAPS.DXF')[0]).toEqual({ name: 'AutoCAD DXF drawing', extensions: ['dxf'] });
  });

  it('offers only "All files" when there is no extension to filter on', () => {
    expect(assetFilters('noextension')).toEqual([{ name: 'All files', extensions: ['*'] }]);
    expect(assetFilters('')).toEqual([{ name: 'All files', extensions: ['*'] }]);
  });
});
