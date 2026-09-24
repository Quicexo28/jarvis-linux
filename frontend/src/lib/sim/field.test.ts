import { describe, it, expect } from 'vitest'
import { buildField, fieldPreset, sampleField, streamline, VectorField, FieldEngine } from './field'
import type { Vec3 } from './types'

describe('VectorField', () => {
  it('evaluates the components with x,y,z,t,r in scope', () => {
    const f = new VectorField('y', '-x', 'r + t')
    const out: Vec3 = [0, 0, 0]
    f.at(3, 4, 0, 2, out)
    expect(out[0]).toBe(4)
    expect(out[1]).toBe(-3)
    expect(out[2]).toBe(7)   // r = 5, t = 2
  })

  it('marks an unparseable field invalid instead of throwing', () => {
    const f = new VectorField('sin(', ')cos', '**')
    expect(f.valid).toBe(false)
    const out: Vec3 = [0, 0, 0]
    expect(() => f.at(1, 1, 1, 0, out)).not.toThrow()
    expect(out).toEqual([0, 0, 0])
  })
})

describe('sampleField', () => {
  it('fills a 3D lattice of density³ arrows', () => {
    const s = sampleField(new VectorField('1', '0', '0'), 4, 5, undefined, 0)
    expect(s.magnitudes.length).toBe(125)
    expect(s.maxMagnitude).toBeCloseTo(1, 12)
  })

  it('collapses to one plane when asked', () => {
    const s = sampleField(new VectorField('1', '0', '0'), 4, 6, 'xy', 0)
    expect(s.magnitudes.length).toBe(36)
    for (let i = 0; i < s.magnitudes.length; i++) expect(s.origins[i * 3 + 2]).toBe(0)
  })

  it('a vortex field is everywhere perpendicular to the radius', () => {
    const s = sampleField(new VectorField('-y', 'x', '0'), 3, 5, 'xy', 0)
    for (let i = 0; i < s.magnitudes.length; i++) {
      const k = i * 3
      const dot = s.origins[k] * s.vectors[k] + s.origins[k + 1] * s.vectors[k + 1]
      expect(Math.abs(dot)).toBeLessThan(1e-9)
    }
  })

  it('a radial source points outward everywhere', () => {
    const s = sampleField(new VectorField('x', 'y', 'z'), 3, 4, undefined, 0)
    for (let i = 0; i < s.magnitudes.length; i++) {
      const k = i * 3
      const dot = s.origins[k] * s.vectors[k] + s.origins[k + 1] * s.vectors[k + 1] + s.origins[k + 2] * s.vectors[k + 2]
      expect(dot).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('streamline', () => {
  it('traces a circle through a vortex field', () => {
    const line = streamline(new VectorField('-y', 'x', '0'), [2, 0, 0], 300, 0.04)
    const r0 = 2
    for (let i = 0; i < line.length; i += 3) {
      expect(Math.hypot(line[i], line[i + 1])).toBeCloseTo(r0, 1)
      expect(line[i + 2]).toBeCloseTo(0, 9)
    }
  })

  it('stops early where the field vanishes', () => {
    const line = streamline(new VectorField('0', '0', '0'), [1, 1, 1], 200, 0.1)
    expect(line.length).toBe(3)
  })
})

describe('presets', () => {
  it('exposes the canonical fields', () => {
    for (const n of ['dipole', 'vortex', 'source', 'wire', 'saddle', 'wave']) {
      const p = fieldPreset(n)
      expect(p.title).toBeTruthy()
      expect(p.fx).toBeTruthy()
    }
  })

  it('falls back to the dipole for an unknown name', () => {
    expect(fieldPreset('nope').title).toBe(fieldPreset('dipole').title)
  })

  it('detects a time-dependent field', () => {
    expect(buildField({ system: 'field', preset: 'wave' }).timeDependent).toBe(true)
    expect(buildField({ system: 'field', preset: 'vortex' }).timeDependent).toBe(false)
  })

  it('an explicit field overrides the preset', () => {
    const b = buildField({ system: 'field', preset: 'vortex', fx: 'z' })
    expect(b.fx).toBe('z')
    expect(b.fy).toBe('x')   // still from the preset
  })

  it('caps the arrow density', () => {
    expect(buildField({ system: 'field', density: 99 }).density).toBe(12)
  })
})

describe('FieldEngine', () => {
  it('advects tracers around a vortex at constant radius', () => {
    const e = new FieldEngine(buildField({
      system: 'field', fx: '-y', fy: 'x', fz: '0', extent: 4, tracers: 20, plane: 'xy', dt: 0.01,
    }))
    const radiusOf = (p: Float32Array, i: number) => Math.hypot(p[i * 3], p[i * 3 + 1])
    const before = Array.from({ length: e.bodyCount }, (_, i) => radiusOf(e.frame().positions, i))
    for (let i = 0; i < 300; i++) e.step()
    const after = Array.from({ length: e.bodyCount }, (_, i) => radiusOf(e.frame().positions, i))
    after.forEach((r, i) => expect(r).toBeCloseTo(before[i], 3))
  })

  it('moves tracers along the field, not against it', () => {
    const e = new FieldEngine(buildField({
      system: 'field', fx: '1', fy: '0', fz: '0', extent: 6, tracers: 5, dt: 0.01,
    }))
    const x0 = e.frame().positions[0]
    for (let i = 0; i < 50; i++) e.step()
    expect(e.frame().positions[0]).toBeGreaterThan(x0)
  })

  it('recycles tracers that leave the box so the picture never empties', () => {
    const e = new FieldEngine(buildField({
      system: 'field', fx: '3', fy: '0', fz: '0', extent: 2, tracers: 30, dt: 0.05,
    }))
    for (let i = 0; i < 400; i++) e.step()
    const p = e.frame().positions
    for (let i = 0; i < e.bodyCount; i++) expect(Math.abs(p[i * 3])).toBeLessThan(2 * 1.26)
  })

  it('produces the requested number of streamlines', () => {
    const e = new FieldEngine(buildField({ system: 'field', preset: 'wire' }))
    expect(e.streamlines().length).toBe(16)
    expect(e.streamlines()[0].length % 3).toBe(0)
  })

  it('a time-dependent field actually changes between samples', () => {
    const e = new FieldEngine(buildField({
      system: 'field', fx: '0', fy: '0', fz: 'sin(x - 2*t)', extent: 4, tracers: 0, dt: 0.05, plane: 'xy',
    }))
    const a = e.sample().vectors.slice()
    for (let i = 0; i < 20; i++) e.step()
    const b = e.sample().vectors
    let changed = false
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) changed = true
    expect(changed).toBe(true)
  })

  it('reset restores the tracer positions', () => {
    const e = new FieldEngine(buildField({ system: 'field', preset: 'vortex', tracers: 10 }))
    const p0 = e.frame().positions.slice()
    for (let i = 0; i < 100; i++) e.step()
    e.reset()
    expect(Array.from(e.frame().positions)).toEqual(Array.from(p0))
  })
})

describe('magnitud a lo largo de una línea de campo', () => {
  it('crece al acercarse a la fuente de un campo 1/r²', () => {
    // Un monopolo: |F| = 1/r². La línea sale hacia fuera desde cerca del
    // centro, así que su magnitud tiene que DECRECER a lo largo del recorrido.
    // Es lo que hace legible el color: el degradado cuenta la caída del campo.
    const eng = new FieldEngine(buildField({
      system: 'field', fx: 'x/(r^3+0.01)', fy: 'y/(r^3+0.01)', fz: 'z/(r^3+0.01)',
      extent: 4, streamlines: 1, tracers: 0,
    }))
    const [line] = eng.streamlines()
    expect(line.length).toBeGreaterThan(30)
    const mags = eng.streamlineMagnitudes(line)
    expect(mags.length).toBe(line.length / 3)
    expect(mags.every((m) => Number.isFinite(m) && m >= 0)).toBe(true)
    expect(mags[mags.length - 1]).toBeLessThan(mags[0])
  })

  it('un campo uniforme sale plano (nada que colorear)', () => {
    const eng = new FieldEngine(buildField({
      system: 'field', fx: '0', fy: '0', fz: '1', extent: 3, streamlines: 1, tracers: 0,
    }))
    const [line] = eng.streamlines()
    const mags = eng.streamlineMagnitudes(line)
    for (const m of mags) expect(m).toBeCloseTo(1, 9)
  })

  it('los presets canónicos traen todos líneas de campo', () => {
    // El vórtice, la fuente y la silla salían SIN líneas: solo flechas y
    // trazadores. Las líneas se integran una vez al construir la escena, así
    // que su coste es estático — no hay razón para que falten.
    for (const preset of ['dipole', 'vortex', 'source', 'wire', 'saddle'] as const) {
      const b = buildField({ system: 'field', preset })
      expect(b.streamlines, preset).toBeGreaterThan(0)
    }
  })
})
