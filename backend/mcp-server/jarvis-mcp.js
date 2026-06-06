#!/usr/bin/env node
/**
 * Jarvis MCP server (stdio).
 *
 * Exposes Jarvis primitives (timer, chronometer, reminders, notifications,
 * current time) as MCP tools so the Claude CLI session that powers the voice
 * pipeline can drive them natively via tool-calling — no regex/router needed.
 *
 * Each tool handler is a thin HTTP bridge: POST localhost:<BACKEND_PORT>/api/skills/...
 * The backend owns the skillBus connection to the renderer and is the single
 * source of truth for state.
 *
 * Configured in ~/.jarvis-claude-cfg-mcp/settings.json (see claudeCli.js).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const BACKEND = process['env']['JARVIS_BACKEND_URL'] || 'http://localhost:8788'

const TOOLS = [
  {
    name: 'timer_start',
    description: 'Inicia un temporizador (cuenta regresiva con alarma local). Para "5 minutos" pasa seconds=300.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', minimum: 1, description: 'Duración en segundos enteros' },
        label:   { type: 'string',  description: 'Etiqueta opcional (objeto/actividad, ej "pasta")' },
      },
      required: ['seconds'],
    },
    method: 'POST', path: '/api/skills/timer/start',
  },
  {
    name: 'timer_pause',
    description: 'Pausa un temporizador activo. Si hay varios, indica label.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/timer/pause',
  },
  {
    name: 'timer_resume',
    description: 'Reanuda un temporizador pausado.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/timer/resume',
  },
  {
    name: 'timer_add',
    description: 'Agrega tiempo a un temporizador activo. seconds = cuánto sumar.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', minimum: 1 },
        label:   { type: 'string' },
      },
      required: ['seconds'],
    },
    method: 'POST', path: '/api/skills/timer/add',
  },
  {
    name: 'timer_cancel',
    description: 'Cancela temporizador. all=true para cancelar todos.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        all:   { type: 'boolean' },
      },
    },
    method: 'POST', path: '/api/skills/timer/cancel',
  },
  {
    name: 'timer_reset',
    description: 'Reinicia un temporizador a su duración original.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/timer/reset',
  },
  {
    name: 'timer_list',
    description: 'Lista los temporizadores activos.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/timer/list',
  },
  {
    name: 'chrono_start',
    description: 'Inicia un cronómetro (cuenta progresiva con vueltas).',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/chrono/start',
  },
  {
    name: 'chrono_pause',
    description: 'Pausa un cronómetro.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/chrono/pause',
  },
  {
    name: 'chrono_resume',
    description: 'Reanuda un cronómetro pausado.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/chrono/resume',
  },
  {
    name: 'chrono_reset',
    description: 'Pone un cronómetro en cero.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/chrono/reset',
  },
  {
    name: 'chrono_lap',
    description: 'Marca una vuelta en un cronómetro.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    method: 'POST', path: '/api/skills/chrono/lap',
  },
  {
    name: 'chrono_cancel',
    description: 'Cancela cronómetro. all=true para cancelar todos.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        all:   { type: 'boolean' },
      },
    },
    method: 'POST', path: '/api/skills/chrono/cancel',
  },
  {
    name: 'chrono_list',
    description: 'Lista los cronómetros activos.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/chrono/list',
  },
  {
    name: 'reminder_create',
    description: 'Crea un recordatorio programado que envía mensaje Telegram al usuario a la hora indicada. when_iso debe ser ISO 8601 con offset, ej "2026-05-26T20:00:00-05:00".',
    inputSchema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Texto del recordatorio (qué recordar)' },
        when_iso: { type: 'string', description: 'Hora ISO 8601 cuando dispararse, con offset -05:00 (Bogotá)' },
        repeat:   { type: 'string', enum: ['hourly','daily','weekly'], description: 'Repetición opcional' },
      },
      required: ['text', 'when_iso'],
    },
    method: 'POST', path: '/api/skills/reminder/create',
  },
  {
    name: 'reminder_list',
    description: 'Lista recordatorios pendientes.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/reminder/list',
  },
  {
    name: 'notify_now',
    description: 'Envía notificación inmediata por Telegram al usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Mensaje a enviar (corto, con emoji opcional al inicio)' },
      },
      required: ['text'],
    },
    method: 'POST', path: '/api/skills/notify/now',
  },
  {
    name: 'current_time',
    description: 'Obtiene la fecha y hora actual en zona Bogotá (America/Bogota). Útil para calcular when_iso de un recordatorio.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/time/now',
  },

  /* ----- Navigation ----- */
  {
    name: 'open_view',
    description: 'Abre una vista del ring de Jarvis. Modos disponibles: home (centro de mando), house (casa/Stark Tower), plan2d (plano 2D), plan3d (plano 3D navegable), space (vista inmersiva primera persona), cloud (nube familiar), system (telemetría + config móvil), utils (sub-ring de utilidades), timer (temporizadores), chrono (cronómetros).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['home','house','plan2d','plan3d','space','cloud','system','mobile','utils','timer','chrono'],
        },
      },
      required: ['view'],
    },
    method: 'POST', path: '/api/skills/view/open',
  },
  {
    name: 'close_view',
    description: 'Cierra la vista actual. Si hay zoom abierto retrocede al ring; si está en sub-ring (house-sub o utils-sub) regresa al main ring.',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/view/close',
  },
  {
    name: 'current_view',
    description: 'Reporta dónde está Jarvis ahora: mode, zoomedMode, ringLevel, activeRingMode, bootState, overlays abiertos, voiceEnabled, clapWakeEnabled. Úsalo cuando necesites saber el contexto antes de actuar.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/view/current',
  },
  {
    name: 'ring_rotate',
    description: 'Rota el ring un paso a la izquierda o derecha. steps opcional (1-10, default 1). "right" avanza al siguiente slot.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['left', 'right'] },
        steps:     { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['direction'],
    },
    method: 'POST', path: '/api/skills/ring/rotate',
  },
  {
    name: 'open_overlay',
    description: 'Abre una ventana auxiliar: terminal (CLI Jarvis), gesture_debug (debug de gestos), gesture_trainer (entrenar gestos ML), clap_trainer (entrenar aplauso), speaker_config (configurar voz/speaker ID).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['terminal','gesture_debug','gesture_trainer','clap_trainer','speaker_config'] },
      },
      required: ['name'],
    },
    method: 'POST', path: '/api/skills/overlay/open',
  },
  {
    name: 'close_overlay',
    description: 'Cierra una ventana auxiliar previamente abierta.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['terminal','gesture_debug','gesture_trainer','clap_trainer','speaker_config'] },
      },
      required: ['name'],
    },
    method: 'POST', path: '/api/skills/overlay/close',
  },
  {
    name: 'sleep_system',
    description: 'Manda a Jarvis a dormir (boot state DORMANT). La interfaz se oculta. Sólo úsalo cuando el señor pida explícitamente "descansa", "duerme", "silencio total", "ya termina". No es para pausar la voz; eso es toggle_voice.',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/system/sleep',
  },
  {
    name: 'toggle_voice',
    description: 'Activa o desactiva la captura de voz (STT). Si enabled se omite, alterna. Usa esto cuando el señor pida "apaga la voz", "no me escuches un momento", "vuelve a escucharme".',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
    },
    method: 'POST', path: '/api/skills/voice/toggle',
  },
  {
    name: 'toggle_clap_wake',
    description: 'Activa o desactiva el wake por doble aplauso. Si enabled se omite, alterna.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
    },
    method: 'POST', path: '/api/skills/clap/toggle',
  },

  /* ----- Obsidian ----- */
  {
    name: 'obsidian_task_create',
    description: 'Crea una tarea en la bóveda Obsidian del señor. Úsalo cuando el señor diga "recuérdame", "anótame", "agéndame", "pon en mi lista", "nueva tarea".',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Descripción de la tarea a crear' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['text'],
    },
    method: 'POST', path: '/api/skills/obsidian/task',
  },
  {
    name: 'obsidian_note_create',
    description: 'Guarda una nota en Obsidian. Úsalo cuando el señor diga "toma nota", "guarda esto", "apúntame".',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Contenido de la nota' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['body'],
    },
    method: 'POST', path: '/api/skills/obsidian/note',
  },
  {
    name: 'obsidian_task_list',
    description: 'Lista las tareas abiertas del señor en Obsidian.',
    inputSchema: {
      type: 'object',
      properties: {
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
    },
    method: 'GET', path: '/api/skills/obsidian/tasks',
  },
  {
    name: 'obsidian_note_search',
    description: 'Busca notas en Obsidian por texto o tema.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en las notas' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['query'],
    },
    method: 'POST', path: '/api/skills/obsidian/search',
  },
  {
    name: 'obsidian_personalize',
    description: 'Guarda un dato personal del señor en Obsidian (preferencias, datos biográficos, etc.). Úsalo cuando el señor diga "recuerda que", "soy", "mi cumpleaños es", "prefiero".',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'El dato o preferencia a recordar' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['fact'],
    },
    method: 'POST', path: '/api/skills/obsidian/personalize',
  },

  /* ----- Display / Picker ----- */
  {
    name: 'show_display',
    description: 'Muestra un cartel en pantalla con contenido difícil de decir en voz: rutas de archivo, URLs, direcciones, fórmulas matemáticas, tablas o listas. ÚSALO en vez de leer en voz alta rutas/URLs/fórmulas — en la voz da solo un resumen natural ("te muestro la ruta", "ahí está la fórmula"). kind: path|url|formula|text|markdown|candidates. Para formula, body es LaTeX. Para candidates, items=[{label,value,meta}].',
    inputSchema: {
      type: 'object',
      properties: {
        kind:    { type: 'string', enum: ['path', 'url', 'formula', 'text', 'markdown', 'candidates'] },
        title:   { type: 'string', description: 'Encabezado corto, ej "Ruta movida"' },
        body:    { type: 'string', description: 'Contenido: ruta/URL/LaTeX/texto. No para candidates.' },
        items:   {
          type: 'array',
          description: 'Solo para kind=candidates: opciones a elegir.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              meta:  { type: 'string' },
            },
            required: ['label', 'value'],
          },
        },
        caption: { type: 'string', description: 'Nota al pie opcional' },
      },
      required: ['kind'],
    },
    method: 'POST', path: '/api/skills/display/show',
  },
  {
    name: 'hide_display',
    description: 'Oculta el cartel en pantalla. Úsalo cuando el señor diga "cierra eso", "quítalo", o cuando el contenido ya no sea relevante.',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/display/hide',
  },
  {
    name: 'pick_file',
    description: 'Abre el selector de archivos nativo de Windows para que el señor señale un archivo o carpeta visualmente, en vez de dictar la ruta. Úsalo cuando necesites que elija un archivo y no sepas cuál, o cuando él diga "déjame escogerlo". Devuelve las rutas seleccionadas.',
    inputSchema: {
      type: 'object',
      properties: {
        title:     { type: 'string', description: 'Título del diálogo, ej "Elige el archivo a mover"' },
        multiple:  { type: 'boolean', description: 'Permitir varios' },
        directory: { type: 'boolean', description: 'Elegir carpeta en vez de archivo' },
      },
    },
    method: 'POST', path: '/api/skills/file/pick',
  },

  /* ----- Visor 3D ----- */
  {
    name: 'show_3d',
    description: 'Muestra el visor 3D de figuras matemáticas. kind="parametric" (superficie x/y/z en u,v, mathjs), kind="polytope" (hipercubo/cross N-D), o kind="implicit" (isosuperficie f(x,y,z)=isoValue por marching cubes — para superficies de Fermi, gyroides, metaballs). Ejemplos: toro = {kind:"parametric", x:"cos(u)*(2+cos(v))", y:"sin(u)*(2+cos(v))", z:"sin(v)", uRange:[0,6.28], vRange:[0,6.28]}. Teseracto = {kind:"polytope", type:"hypercube", dimension:4}. SUPERFICIE DE FERMI DEL COBRE (FCC, banda-s tight-binding, recortada a la 1ª zona de Brillouin) = {kind:"implicit", f:"-(cos(x)*cos(y)+cos(y)*cos(z)+cos(z)*cos(x))", isoValue:-0.5, bounds:[-3.1416,3.1416], brillouinZone:"fcc", title:"Superficie de Fermi — Cu"}. (isoValue cerca de -0.5 produce los cuellos en ⟨111⟩ que tocan los puntos L.) Para cerrar usa hide_3d.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['parametric', 'polytope', 'implicit'], description: 'Tipo de figura' },
        x: { type: 'string', description: '[parametric] expresión mathjs para x(u,v)' },
        y: { type: 'string', description: '[parametric] expresión mathjs para y(u,v)' },
        z: { type: 'string', description: '[parametric] expresión mathjs para z(u,v)' },
        uRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de u: [min, max]' },
        vRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de v: [min, max]' },
        segments: { type: 'integer', minimum: 8, maximum: 120, description: '[parametric] resolución de la malla, default 64' },
        type: { type: 'string', enum: ['hypercube', 'cross'], description: '[polytope] tipo: hypercube (teseracto y más) o cross (ortoplex)' },
        dimension: { type: 'integer', minimum: 2, maximum: 7, description: '[polytope] número de dimensiones (4 = teseracto)' },
        f: { type: 'string', description: '[implicit] expresión mathjs f(x,y,z); se dibuja la isosuperficie f=isoValue. Para Fermi es la energía E(kx,ky,kz).' },
        isoValue: { type: 'number', description: '[implicit] valor de la isosuperficie (nivel de Fermi)' },
        bounds: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[implicit] caja de muestreo [min,max] por eje, default [-3.1416,3.1416]' },
        resolution: { type: 'integer', minimum: 8, maximum: 64, description: '[implicit] celdas por eje del marching cubes, default 40' },
        brillouinZone: { type: 'string', enum: ['fcc', 'bcc', 'sc'], description: '[implicit] recorta a la 1ª zona de Brillouin de esta red (fcc=cobre, octaedro truncado)' },
        title: { type: 'string', description: 'Título a mostrar en el visor' },
        color: { type: 'string', description: 'color hex (parametric "#38d5ff", implicit "#ffb347")' },
      },
      required: ['kind'],
    },
    method: 'POST', path: '/api/skills/model3d/show',
  },
  {
    name: 'hide_3d',
    description: 'Cierra el visor 3D. Úsalo cuando el señor diga "cierra eso", "ya está", "quita la figura".',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/model3d/hide',
  },

  /* ----- Cloud ----- */
  {
    name: 'cloud_save',
    description: 'Guarda contenido en la nube personal del señor y notifica por Telegram. Úsalo cuando el señor pida "sube esto a la nube", "guárdalo en mi nube", "ponlo en la nube".',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Contenido del archivo a guardar' },
        filename: { type: 'string', description: 'Nombre del archivo (opcional, se genera si no se indica)' },
        category: { type: 'string', description: 'Categoría del archivo (opcional, ej: "Documentos")' },
      },
      required: ['content'],
    },
    method: 'POST', path: '/api/skills/cloud/save',
  },
  {
    name: 'cloud_list',
    description: 'Lista los archivos recientes en la nube del señor.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Número máximo de archivos a retornar (default 12)' },
      },
    },
    method: 'GET', path: '/api/skills/cloud/list',
  },
]

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

async function callBackend(tool, args) {
  let url = `${BACKEND}${tool.path}`
  const init = {
    method: tool.method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (tool.method !== 'GET') {
    init.body = JSON.stringify(args || {})
  } else if (args && Object.keys(args).length > 0) {
    url += '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
    ).toString()
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { ok: res.ok, raw: text } }
  if (!res.ok || data.ok === false) {
    const err = (data && (data.error || data.detail)) || `http_${res.status}`
    throw new Error(err)
  }
  return data
}

const server = new Server(
  { name: 'jarvis-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const tool = TOOL_BY_NAME[name]
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Tool desconocida: ${name}` }],
      isError: true,
    }
  }
  try {
    const result = await callBackend(tool, args || {})
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error ejecutando ${name}: ${e.message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
