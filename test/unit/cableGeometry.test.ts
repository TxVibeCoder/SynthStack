import { describe, expect, it } from 'vitest';
import { cableColor, cablePath, cableSag, nextCableId, sharedOutputOffset } from '../../src/ui/cables/cableGeometry';

describe('cable geometry (work order §8.2)', () => {
  it('sag = 0.15·distance + 30', () => {
    expect(cableSag({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(30);
    expect(cableSag({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(45, 6);
  });

  it('path runs endpoint to endpoint with dropped control points', () => {
    const p = cablePath({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(p.startsWith('M 0.0 0.0 C ')).toBe(true);
    expect(p.endsWith('100.0 0.0')).toBe(true);
    expect(p).toContain('25.0 45.0'); // c1 dropped by sag
  });

  it('colors cycle the palette', () => {
    const pal = ['a', 'b', 'c'];
    expect(cableColor(0, pal)).toBe('a');
    expect(cableColor(4, pal)).toBe('b');
  });

  it('shared-output offsets alternate and grow', () => {
    expect([0, 1, 2, 3, 4].map(sharedOutputOffset)).toEqual([0, 4, -4, 8, -8]);
  });

  it('cable ids increment past the max suffix', () => {
    expect(nextCableId([])).toBe('c1');
    expect(nextCableId([{ id: 'c2' }, { id: 'c7' }, { id: 'weird' }])).toBe('c8');
  });
});
