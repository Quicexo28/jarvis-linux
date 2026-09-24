import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HUE, TEXT, BG, FOLDER_HUE, FALLBACK_RAMP,
  folderHue, nodeHue, severityHue, hexToRgb, withAlpha, mixHex,
  contrastRatio, cssVars,
} from './theme'

const CSS_PATH = resolve(__dirname, '../styles/design-system.css')

/** Pares `--name: value;` del PRIMER bloque `:root` del stylesheet. */
function rootVars(): Record<string, string> {
  const css = readFileSync(CSS_PATH, 'utf8')
  const start = css.indexOf(':root {')
  expect(start, 'el stylesheet debe declarar un bloque :root').toBeGreaterThan(-1)
  const end = css.indexOf('\n}', start)
  const block = css.slice(start, end)
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim()
  }
  return out
}

describe('paridad theme.ts ↔ design-system.css', () => {
  // Esta es la guardarraíl del sistema: el 3D lee el hex de theme.ts y el DOM
  // lee la variable CSS. Si alguien toca un solo lado, el mismo concepto se
  // pinta de dos colores distintos y nadie se entera hasta verlo en pantalla.
  it('el CSS declara cada token que theme.ts exige, con el mismo valor', () => {
    const css = rootVars()
    const missing: string[] = []
    const wrong: string[] = []
    for (const [name, value] of Object.entries(cssVars())) {
      if (!(name in css)) { missing.push(name); continue }
      if (css[name].toLowerCase() !== value.toLowerCase()) {
        wrong.push(`${name}: CSS=${css[name]} vs theme.ts=${value}`)
      }
    }
    expect(missing, 'tokens ausentes en el CSS').toEqual([])
    expect(wrong, 'tokens con valor divergente').toEqual([])
  })

  it('los alias de compatibilidad apuntan a roles, no a hex sueltos', () => {
    const css = rootVars()
    expect(css['--primary']).toBe('var(--hue-info)')
    expect(css['--accent']).toBe('var(--hue-deep)')
  })
})

describe('folderHue', () => {
  it('devuelve el hue curado de las carpetas conocidas', () => {
    expect(folderHue('03-Conocimiento')).toBe(HUE.info)
    expect(folderHue('02-Proyectos')).toBe(HUE.attn)
    expect(folderHue('memoria')).toBe(FOLDER_HUE.memoria)
  })

  it('asigna un color estable a una carpeta desconocida', () => {
    const a = folderHue('99-Carpeta-Nueva')
    const b = folderHue('99-Carpeta-Nueva')
    expect(a).toBe(b)
    expect(FALLBACK_RAMP).toContain(a)
  })

  it('carpetas distintas no colapsan todas en el mismo color', () => {
    const hues = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => folderHue(`carpeta-${s}`)),
    )
    expect(hues.size).toBeGreaterThan(1)
  })

  it('carpeta vacía cae en idle, no en un color inventado', () => {
    expect(folderHue('')).toBe(HUE.idle)
  })
})

describe('nodeHue', () => {
  it('el tipo solo manda cuando dice algo que la carpeta no dice', () => {
    // Fantasma = enlace a una nota que no existe todavía → apagado.
    expect(nodeHue({ folder: '02-Proyectos', type: 'ghost' })).toBe(HUE.idle)
    // Tag = metadato, no contenido.
    expect(nodeHue({ folder: '02-Proyectos', type: 'tag' })).toBe(FOLDER_HUE.tags)
    // Todo lo demás lo decide la carpeta.
    expect(nodeHue({ folder: '02-Proyectos', type: 'note' })).toBe(HUE.attn)
    expect(nodeHue({ folder: 'memoria', type: 'fact' })).toBe(FOLDER_HUE.memoria)
  })

  it('un nodo sin carpeta ni tipo no lanza', () => {
    expect(nodeHue({})).toBe(HUE.idle)
  })
})

describe('severityHue', () => {
  it('escala info → attn → fail al subir el valor', () => {
    const t = { warn: 70, crit: 90 }
    expect(severityHue(10, t)).toBe(HUE.info)
    expect(severityHue(70, t)).toBe(HUE.attn)
    expect(severityHue(89, t)).toBe(HUE.attn)
    expect(severityHue(90, t)).toBe(HUE.fail)
    expect(severityHue(100, t)).toBe(HUE.fail)
  })

  it('invert cubre las métricas donde lo BAJO es lo malo (batería)', () => {
    const t = { warn: 30, crit: 10, invert: true }
    expect(severityHue(80, t)).toBe(HUE.info)
    expect(severityHue(30, t)).toBe(HUE.attn)
    expect(severityHue(10, t)).toBe(HUE.fail)
    expect(severityHue(2, t)).toBe(HUE.fail)
  })

  it('un valor no medible es idle, nunca verde: "sin dato" no es "está bien"', () => {
    expect(severityHue(NaN, { warn: 1, crit: 2 })).toBe(HUE.idle)
    expect(severityHue(Infinity, { warn: 1, crit: 2 })).toBe(HUE.idle)
  })
})

describe('utilidades de color', () => {
  it('hexToRgb acepta con y sin almohadilla', () => {
    expect(hexToRgb('#00f0ff')).toEqual([0, 240, 255])
    expect(hexToRgb('00f0ff')).toEqual([0, 240, 255])
  })

  it('hexToRgb lanza ante un hex inválido', () => {
    expect(() => hexToRgb('#xyz')).toThrow()
    expect(() => hexToRgb('#fff')).toThrow() // la forma corta no se soporta a propósito
  })

  it('withAlpha recorta el alpha al rango válido', () => {
    expect(withAlpha('#00f0ff', 0.5)).toBe('rgba(0, 240, 255, 0.5)')
    expect(withAlpha('#00f0ff', 5)).toBe('rgba(0, 240, 255, 1)')
    expect(withAlpha('#00f0ff', -1)).toBe('rgba(0, 240, 255, 0)')
  })

  it('mixHex respeta los extremos y recorta t', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff')
  })
})

describe('legibilidad', () => {
  // Un hue que no se ve contra el fondo es un bug de accesibilidad, no una
  // elección estética. 3:1 es el mínimo WCAG para gráficos y texto grande.
  it('todos los roles contrastan al menos 3:1 contra el fondo', () => {
    for (const [role, hex] of Object.entries(HUE)) {
      if (role === 'deep') continue // 'deep' es color de SOMBRA, nunca de primer plano
      expect(contrastRatio(hex, BG), `${role} (${hex})`).toBeGreaterThanOrEqual(3)
    }
  })

  it('el texto primario contrasta al menos 4.5:1', () => {
    expect(contrastRatio(TEXT.primary, BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('cada hue de carpeta es legible contra el fondo', () => {
    for (const [folder, hex] of Object.entries(FOLDER_HUE)) {
      expect(contrastRatio(hex, BG), `${folder} (${hex})`).toBeGreaterThanOrEqual(3)
    }
  })
})
