import type { Mode } from './types'

export const GRID_CELLS = 40
export const CELL_METERS = 0.25
export const VIEWBOX_SIZE = 800
export const STEP = VIEWBOX_SIZE / GRID_CELLS
export const PLAN_STORAGE_KEY = 'jarvis.plan2d.saved.v1'
export const PLAN3D_ENTITY_STORAGE_KEY = 'jarvis.plan3d.entities.v1'
export const PLAN3D_VIEWPOINT_STORAGE_KEY = 'jarvis.plan3d.viewpoint.v1'

export const modeMeta: Record<Mode, { label: string; title: string; subtitle: string }> = {
  home: { label: 'Core', title: 'Jarvis Core', subtitle: 'Centro de mando personal · comando, voz y escenas contextuales' },
  house: { label: 'Casa', title: 'Casa / Torre Stark', subtitle: 'Instancia de Casa con acceso visual modular.' },
  plan2d: { label: 'Plano', title: 'Plano 2D rápido', subtitle: 'Dibujo por líneas sobre grid (1 celda = 25 cm).' },
  plan3d: { label: 'Espacio 3D', title: 'Espacio 3D desde plano', subtitle: 'Conversión simple de líneas 2D a muros 3D navegables.' },
  space: { label: 'Inmersivo', title: 'Espacio Inmersivo', subtitle: 'Punto de vista fijo con detección por mirada y acciones de dispositivo.' },
  cloud: { label: 'Cloud', title: 'Visual de Nube Familiar', subtitle: 'Archivos y servicios familiares en una escena holográfica limpia' },
  system: { label: 'System', title: 'Visual del Sistema', subtitle: 'Telemetría orbital del gateway, la máquina y la red local' },
  mobile: { label: 'Mobile', title: 'Cliente Móvil', subtitle: 'Acceso remoto desde dispositivo móvil.' },
  utils:  { label: 'Utilidades', title: 'Herramientas', subtitle: 'Temporizadores, cronómetros y herramientas rápidas.' },
  timer:  { label: 'Temporizador', title: 'Temporizadores', subtitle: 'Cuenta regresiva con alarma. Pausa, reanuda o agrega tiempo.' },
  chrono: { label: 'Cronómetro', title: 'Cronómetros', subtitle: 'Cuenta progresiva con vueltas. Pausa, reanuda o reinicia.' },
}
