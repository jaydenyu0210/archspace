/**
 * The arithmetic under the IFC writer: STEP number formatting, polygon winding,
 * wall framing, and the GUID encoding rule.
 *
 * Every case here corresponds to something that produces a file which parses,
 * opens, and is wrong — which is the only kind of bug this layer has. The
 * winding and framing cases were written against IfcOpenShell's geometry
 * engine; the GUID case against its schema validator, which is what found the
 * bug in the first place.
 */
import { describe, expect, it } from 'vitest';
import {
  counterClockwise,
  signedArea2,
  stepReal,
  stepString,
  wallAxis,
  type Point2,
} from '../src/ifc.js';
import { ifcGuid } from '../src/util.js';

describe('stepReal', () => {
  it('always writes a decimal point, because STEP types 1 as an integer', () => {
    expect(stepReal(0)).toBe('0.');
    expect(stepReal(1)).toBe('1.');
    expect(stepReal(-3500)).toBe('-3500.');
    expect(stepReal(48000)).toBe('48000.');
    for (const n of [0, 1, -1, 0.5, -0.25, 1234.5678, 1e12]) {
      expect(stepReal(n), `${n} needs a point`).toContain('.');
    }
  });

  it('flushes direction-cosine noise to zero instead of exponent notation', () => {
    // A wall running due north has an x-component of about 6e-17, not 0. Written
    // as `6.12e-17` that is not a legal STEP real (no point before the E), and
    // written as `0.00000000000000006` it is noise pretending to be a position.
    expect(stepReal(Math.cos(Math.PI / 2))).toBe('0.');
    expect(stepReal(-1e-15)).toBe('0.');
    expect(stepReal(1e-12)).toBe('0.');
    // Above the threshold the value is kept, because a tenth of a micrometre
    // could still be a real direction cosine on a long wall. Exponent form is
    // fine there — STEP allows it as long as the mantissa keeps its point,
    // which is exactly the part `String(1e-7)` gets wrong.
    expect(stepReal(1e-7)).toMatch(/^\d\.\d*E-?\d+$/);
    expect(Number(stepReal(1e-7))).toBeCloseTo(1e-7, 15);
  });

  it('never emits a mantissa without a decimal point', () => {
    for (const n of [1e-9, 1e20, -1e18, 6.02e23, 1 / 3, Math.PI, 2 ** 0.5]) {
      const out = stepReal(n);
      const mantissa = out.split(/[eE]/)[0] as string;
      expect(mantissa, `${n} -> ${out}`).toContain('.');
    }
  });

  it('keeps enough digits for millimetre geometry', () => {
    // A unit direction for a 3-4-5 wall: exact, and it must survive.
    expect(Number(stepReal(0.6))).toBeCloseTo(0.6, 12);
    expect(Number(stepReal(1 / 3))).toBeCloseTo(1 / 3, 11);
    // Trailing zeros from toPrecision are trimmed, the point is not.
    expect(stepReal(12.5)).toBe('12.5');
    expect(stepReal(0.1)).toBe('0.1');
  });

  it('refuses a non-finite number rather than writing "NaN" into the model', () => {
    expect(() => stepReal(Number.NaN)).toThrow(/non-finite/);
    expect(() => stepReal(Infinity)).toThrow(/non-finite/);
  });
});

describe('stepString', () => {
  it('doubles embedded quotes, which would otherwise end the literal early', () => {
    expect(stepString("Owner's suite")).toBe("'Owner''s suite'");
    expect(stepString('Plain')).toBe("'Plain'");
  });
});

describe('polygon winding', () => {
  const ccw: Point2[] = [
    [0, 0],
    [10, 0],
    [10, 5],
    [0, 5],
  ];
  const cw: Point2[] = [...ccw].reverse();

  it('reports the sign that distinguishes the two windings', () => {
    expect(signedArea2(ccw)).toBeGreaterThan(0);
    expect(signedArea2(cw)).toBeLessThan(0);
    expect(Math.abs(signedArea2(ccw)) / 2).toBe(50);
  });

  it('leaves a counter-clockwise ring alone and flips a clockwise one', () => {
    // A clockwise outer curve extrudes with inverted normals: the room renders
    // inside-out, or not at all, while every number about it stays correct.
    expect(counterClockwise(ccw)).toEqual(ccw);
    expect(counterClockwise(cw)).toEqual(ccw);
    expect(signedArea2(counterClockwise(cw))).toBeGreaterThan(0);
  });

  it('does not mutate the polygon it was handed', () => {
    const original = [...cw];
    counterClockwise(cw);
    expect(cw).toEqual(original);
  });
});

describe('wallAxis', () => {
  it('frames a wall along its own centreline', () => {
    const axis = wallAxis([100, 200], [100 + 3000, 200 + 4000]);
    expect(axis?.origin).toEqual([100, 200]);
    expect(axis?.length).toBe(5000);
    // A 3-4-5 triangle, so the direction is exact.
    expect(axis?.refDirection[0]).toBeCloseTo(0.6, 12);
    expect(axis?.refDirection[1]).toBeCloseTo(0.8, 12);
  });

  it('returns a unit direction, which is what IfcDirection needs', () => {
    for (const end of [
      [1000, 0],
      [0, -2500],
      [-700, 700],
    ] as Point2[]) {
      const axis = wallAxis([0, 0], end);
      expect(Math.hypot(...(axis?.refDirection as Point2))).toBeCloseTo(1, 12);
    }
  });

  it('refuses a zero-length wall instead of emitting a degenerate solid', () => {
    // Invisible in a viewer, still counted in every quantity take-off.
    expect(wallAxis([5, 5], [5, 5])).toBeNull();
  });
});

describe('ifcGuid', () => {
  it('starts with 0-3, because 22 base64 chars hold 132 bits and a UUID has 128', () => {
    // IfcOpenShell's validator rejects anything else. The leading character
    // carries only the top 2 bits; drawing it from all 64 symbols made ~94% of
    // every model's GUIDs non-conformant, invisibly.
    for (let i = 0; i < 500; i++) {
      const guid = ifcGuid(`plan_abc:element_${i}`);
      expect(guid, `guid ${i}`).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    }
  });

  it('is stable for a key and different across keys', () => {
    expect(ifcGuid('a:b')).toBe(ifcGuid('a:b'));
    expect(ifcGuid('a:b')).not.toBe(ifcGuid('a:c'));

    // Constraining the first character costs 4 bits of space; it must not cost
    // more than that in practice.
    const guids = new Set(Array.from({ length: 5000 }, (_, i) => ifcGuid(`p:e_${i}`)));
    expect(guids.size).toBe(5000);
  });
});
