// Validación del kind `polygon`. Unit y no contract a propósito: los contract
// tests hablan con el 8788, que en esta máquina lo ocupa el backend de
// PRODUCCIÓN, así que medirían el código desplegado y no el del árbol.
import { describe, it, expect } from 'vitest'
import { validateModel3dBody } from '../src/handlers/skillTools.js'

function res() {
  const out = { statusCode: 0, body: null }
  return {
    out,
    setHeader() {},
    set statusCode(v) { out.statusCode = v },
    get statusCode() { return out.statusCode },
    end(p) { out.body = JSON.parse(p) },
  }
}

const OK = { kind: 'polygon', vertices: [[0, 0, 0], [1, 0, 0], [0, 0, 1]] }

function check(spec) {
  const r = res()
  validateModel3dBody(spec, r, 'model3d_show')
  return r.out
}

describe('polygon.vertices', () => {
  it('sin renderer conectado, un polígono válido llega hasta el bus (503, no 400)', () => {
    // El 503 es la prueba de que PASÓ la validación: el error ya es de
    // transporte, no de forma.
    expect(check(OK).statusCode).toBe(503)
  })

  it('rechaza vertices que no es lista', () => {
    const out = check({ kind: 'polygon', vertices: 'nope' })
    expect(out.statusCode).toBe(400)
    expect(out.body.error).toBe('invalid_vertices')
  })

  it('rechaza menos de 2 vértices', () => {
    expect(check({ kind: 'polygon', vertices: [[0, 0, 0]] }).body.error).toBe('invalid_vertices')
  })

  it('rechaza ternas incompletas', () => {
    expect(check({ kind: 'polygon', vertices: [[0, 0], [1, 0]] }).body.error).toBe('invalid_vertices')
  })

  it('rechaza NaN e Infinity — la geometría saldría invisible sin ningún error', () => {
    expect(check({ kind: 'polygon', vertices: [[0, 0, 0], [1, NaN, 0], [0, 0, 1]] }).body.error).toBe('invalid_vertices')
    expect(check({ kind: 'polygon', vertices: [[0, 0, 0], [Infinity, 0, 0], [0, 0, 1]] }).body.error).toBe('invalid_vertices')
  })

  it('rechaza más de 512 vértices', () => {
    const many = Array.from({ length: 513 }, (_, i) => [i, 0, 0])
    expect(check({ kind: 'polygon', vertices: many }).body.error).toBe('invalid_vertices')
  })

  it('valida también dentro de objects:[...]', () => {
    const out = check({ objects: [{ kind: 'primitive', shape: 'sphere' }, { kind: 'polygon', vertices: [] }] })
    expect(out.body.error).toBe('invalid_vertices')
  })

  it('polygon es un kind aceptado', () => {
    expect(check({ kind: 'polygon', vertices: [[0, 0, 0], [1, 0, 0]] }).body?.error).not.toBe('invalid_kind')
  })
})
