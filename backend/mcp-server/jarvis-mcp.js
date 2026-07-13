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

  /* ----- Mobile context (rutina del usuario via iPhone) ----- */
  {
    name: 'mobile_where',
    description: 'Dónde está el usuario y estado actual de su celular (ubicación/lugar, batería, modo concentración, dormido/despierto). Úsalo para "¿dónde estoy?", "¿cuánta batería tengo?", "¿estoy en casa?".',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/mobile/where',
  },
  {
    name: 'mobile_routine',
    description: 'Resumen de la rutina del día del usuario a partir de eventos del celular (llegadas/salidas de lugares, cargador, concentración, dormir/despertar). Úsalo para "resumen de mi rutina hoy", "¿qué he hecho hoy?". date opcional YYYY-MM-DD.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'Fecha YYYY-MM-DD (opcional, por defecto hoy)' } } },
    method: 'GET', path: '/api/skills/mobile/routine',
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
    name: 'launch_app',
    description: 'Abre una aplicación del sistema (GUI) en el escritorio del señor vía Hyprland. Úsalo cuando pida "abre/lanza/inicia" una app: "abre el navegador", "lanza la terminal", "abre los archivos", "abre spotify". Pasa el nombre amistoso ("navegador") o el binario directo ("firefox", "kitty"). Para navegador/archivos hay atajos; cualquier otro nombre se ejecuta tal cual.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Nombre amistoso o binario de la app a abrir (ej. "navegador", "firefox", "kitty").' },
      },
      required: ['app'],
    },
    method: 'POST', path: '/api/skills/system/launch',
  },
  {
    name: 'run_terminal',
    description: 'Ejecuta un comando de terminal (shell) en la máquina del señor y devuelve stdout, stderr y código de salida. AUTO MODE: tienes autoridad para hacer lo que el señor pida en el sistema — instalar, mover archivos, consultar estado, encender/apagar servicios, lo que sea. Usa detach=true para procesos GUI o que no terminan (apps, servidores) — no espera salida. Para comandos normales (consultas, scripts) deja detach en false y razona sobre el resultado. Nunca leas rutas ni salida cruda en voz alta; resume en lenguaje natural.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando de shell a ejecutar (bash).' },
        cwd: { type: 'string', description: 'Directorio de trabajo (opcional, default HOME).' },
        detach: { type: 'boolean', description: 'true para lanzar desacoplado sin esperar salida (apps GUI, procesos largos).' },
        timeout: { type: 'integer', description: 'Timeout en ms (opcional, default 30000, máx 300000).' },
      },
      required: ['command'],
    },
    method: 'POST', path: '/api/skills/system/terminal',
  },
  {
    name: 'system_power',
    description: 'Controla la energía del equipo del señor. action: off (apagar), reboot (reiniciar), suspend, lock, logout. "apaga el pc"→off, "reinicia"→reboot, "suspende"→suspend, "bloquea"→lock. SEGURO: off y reboot son irreversibles — la PRIMERA llamada (sin confirm) devuelve needs_confirm=true; NO lo repitas en bucle: pregúntale en voz al señor "¿confirmo que apago/reinicio?" y SOLO si dice que sí, vuelve a llamar con confirm=true. suspend/lock/logout no necesitan confirmación.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['off', 'reboot', 'suspend', 'lock', 'logout'] },
        confirm: { type: 'boolean', description: 'true para ejecutar off/reboot tras confirmación verbal del señor. Omítelo en la primera llamada.' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/power',
  },
  {
    name: 'system_volume',
    description: 'Controla el volumen del sistema (PipeWire). action: up (subir), down (bajar), set (poner en value 0-100), mute (silenciar), unmute, toggle (alternar mute), get (consultar). "sube el volumen"→up, "bájale"→down, "pon el volumen en 30"→set value=30, "silencio"→mute. step opcional para up/down (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'set', 'mute', 'unmute', 'toggle', 'get'] },
        value: { type: 'integer', description: 'Nivel 0-100 para action=set.' },
        step: { type: 'integer', description: 'Paso 1-50 para up/down (default 5).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/volume',
  },
  {
    name: 'system_bluetooth',
    description: 'Gestiona Bluetooth. action: status (estado), devices (emparejados), scan (buscar cercanos), connect/disconnect (target = nombre o MAC), on/off (encender/apagar adaptador). "qué dispositivos bluetooth hay"→devices, "conecta los audífonos"→connect target="audífonos", "busca dispositivos"→scan.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'devices', 'scan', 'connect', 'disconnect', 'on', 'off'] },
        target: { type: 'string', description: 'Nombre (parcial) o MAC del dispositivo para connect/disconnect.' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/bluetooth',
  },
  {
    name: 'system_process',
    description: 'Inspecciona y cierra procesos. action: list (top por CPU), kill (cerrar por name — coincidencia parcial; protege procesos críticos del sistema y a Jarvis). "qué está consumiendo"→list, "cierra spotify"→kill name="spotify". No puede matar systemd/hyprland/pipewire/jarvis ni PIDs bajos.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'kill'] },
        name: { type: 'string', description: 'Nombre del proceso a cerrar (para action=kill).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/process',
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
    description: 'Guarda una nota organizada en la bóveda Obsidian. Úsalo cuando el señor diga "toma nota", "guarda esto", "apúntame". Reglas: conocimiento por tema → "area" (fisica | ia | programacion | tema libre, se crea la carpeta); información de un proyecto → "project" (actualiza 02-Proyectos/<Proyecto>.md, nunca duplica); mediciones/sesiones/capítulos de una misma serie → "series" (subcarpeta con nota hub que enlaza cada entrada). Pasa SIEMPRE "aliases": cómo se menciona el tema hablando, en minúsculas — el auto-linker los usa para conectar el grafo.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Contenido de la nota' },
        title: { type: 'string', description: 'Título descriptivo (el archivo sale en kebab-case de aquí)' },
        area: { type: 'string', description: 'Tema de conocimiento: fisica | ia | programacion | otro tema libre' },
        project: { type: 'string', description: 'Nombre del proyecto si la nota es información de un proyecto (ej. "Jarvis", "App-Entrenamiento")' },
        series: { type: 'string', description: 'Nombre de la serie/experimento si la nota es una entrada de una serie (ej. "tiempo de vuelo")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags del frontmatter (tema, subtema)' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Cómo se menciona hablando, en minúsculas (obligatorio para el grafo)' },
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
    description: `Muestra el visor 3D matemático. Acepta UNA figura (campos al nivel superior) o VARIAS simultáneas en objects:[...], cada una con kind, color, opacity, position/rotation/scale propios (coordenadas matemáticas, z hacia arriba). scene:{axes,grid,title} añade ejes etiquetados y rejilla — NO los actives para figuras sueltas sin referencias posicionales exactas (auto-on ya cubre graph/vectors/plane/line); solo cuando las coordenadas importan o el usuario lo pide.
KINDS: "primitive" (sólidos exactos shape=sphere|box|cylinder|cone|torus — para composiciones con tangencia/contención precisas), "parametric" (superficie x/y/z en u,v, mathjs), "polytope" (hipercubo/cross N-D animado, caras translúcidas y color por 4ª coordenada), "implicit" (isosuperficie f(x,y,z)=isoValue por marching cubes — Fermi, gyroides), "graph" (y=f(x) curva o z=f(x,y) superficie, autodetecta si f usa y), "curve" (curva paramétrica x(t),y(t),z(t)), "vectors" (flechas n-D proyectadas a R³, showSpan dibuja el span de v1,v2), "plane" (plano por normal+point o vectores u,v), "line" (recta point+direction).
EJEMPLOS. Esferas concéntricas: {objects:[{kind:"primitive",shape:"sphere",radius:1,color:"#38d5ff",opacity:0.55},{kind:"primitive",shape:"sphere",radius:1.6,color:"#ff5f8f",opacity:0.3}]}. Cubo inscrito en cilindro (esquinas tocando la pared: radio=(lado/2)*sqrt(2)): {objects:[{kind:"primitive",shape:"cylinder",radius:1.4142,height:2,opacity:0.3},{kind:"primitive",shape:"box",size:[2,2,2],color:"#7cff6b",opacity:0.7}]}. Esferas tangentes: distancia entre centros = r1+r2 (usa position). Teseracto: {kind:"polytope",type:"hypercube",dimension:4,faces:true,speed:1}. Gráfica: {kind:"graph",f:"sin(x)/x",xRange:[-10,10]} (superficie: f:"sin(x)*cos(y)" + yRange). Espacio vectorial: {kind:"vectors",vectors:[[2,1,0],[0,1,2]],labels:["v1","v2"],showSpan:true} (vectores de dimensión >3 se proyectan). Recta: {kind:"line",point:[0,0,1],direction:[1,2,0]}. Plano: {kind:"plane",normal:[1,1,1]}. Fermi del cobre: {kind:"implicit",f:"-(cos(x)*cos(y)+cos(y)*cos(z)+cos(z)*cos(x))",isoValue:-0.5,bounds:[-3.1416,3.1416],brillouinZone:"fcc"}. Para añadir sin borrar usa add_3d; para cerrar, hide_3d.`,
    inputSchema: {
      type: 'object',
      properties: {
        objects: { type: 'array', items: { type: 'object', description: 'Figura — mismos campos que el nivel superior (kind, color, position, ...)' }, description: 'Varias figuras simultáneas. Si se usa, ignora los campos de figura del nivel superior.' },
        scene: {
          type: 'object',
          description: 'Opciones de escena',
          properties: {
            title: { type: 'string' },
            axes: { type: 'boolean', description: 'Ejes x/y/z etiquetados (auto-on para graph/vectors/plane/line)' },
            grid: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['xy', 'xz', 'yz'] }], description: 'Rejilla de referencia en ese plano (true = xy)' },
            axisLength: { type: 'number', description: 'Longitud de los ejes, default 6' },
          },
        },
        kind: { type: 'string', enum: ['parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line'], description: 'Tipo de figura (modo una-sola-figura)' },
        title: { type: 'string', description: 'Nombre de la figura (aparece en la leyenda)' },
        color: { type: 'string', description: 'Color hex de la figura; sin él se asigna una paleta distinta por figura' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Translucidez — clave para figuras contenidas/solapadas' },
        wireframe: { type: 'boolean', description: 'Malla de alambre en vez de sólido' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Centro [x,y,z] en coords matemáticas (z arriba)' },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Euler [rx,ry,rz] en radianes' },
        scale: { type: 'number', description: 'Factor de escala uniforme' },
        x: { type: 'string', description: '[parametric|curve] mathjs x(u,v) o x(t)' },
        y: { type: 'string', description: '[parametric|curve] mathjs y(u,v) o y(t)' },
        z: { type: 'string', description: '[parametric|curve] mathjs z(u,v) o z(t)' },
        uRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de u: [min, max]' },
        vRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de v: [min, max]' },
        segments: { type: 'integer', minimum: 8, maximum: 120, description: '[parametric|graph] resolución de malla' },
        type: { type: 'string', enum: ['hypercube', 'cross'], description: '[polytope] hypercube (teseracto y más) o cross (ortoplex)' },
        dimension: { type: 'integer', minimum: 2, maximum: 7, description: '[polytope] dimensiones (4 = teseracto)' },
        faces: { type: 'boolean', description: '[polytope] caras 2D translúcidas (default: sí en hipercubos 4D+)' },
        speed: { type: 'number', description: '[polytope] multiplicador de la rotación N-D (0 = congelar)' },
        colorByW: { type: 'boolean', description: '[polytope] colorear por la 4ª coordenada (default: sí en 4D+)' },
        f: { type: 'string', description: '[implicit] f(x,y,z) para isosuperficie · [graph] f(x) o f(x,y)' },
        isoValue: { type: 'number', description: '[implicit] valor de la isosuperficie (nivel de Fermi)' },
        bounds: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[implicit] caja de muestreo [min,max] por eje' },
        resolution: { type: 'integer', minimum: 8, maximum: 64, description: '[implicit] celdas del marching cubes, default 40' },
        brillouinZone: { type: 'string', enum: ['fcc', 'bcc', 'sc'], description: '[implicit] recorta a la 1ª zona de Brillouin' },
        shape: { type: 'string', enum: ['sphere', 'box', 'cylinder', 'cone', 'torus'], description: '[primitive] sólido exacto' },
        radius: { type: 'number', description: '[primitive] radio (torus: radio mayor)' },
        size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[primitive box] lados [sx,sy,sz]' },
        height: { type: 'number', description: '[primitive cylinder|cone] altura (eje = z matemático)' },
        tube: { type: 'number', description: '[primitive torus] radio del tubo' },
        tRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[curve] rango del parámetro t' },
        samples: { type: 'integer', minimum: 16, maximum: 1024, description: '[curve|graph] puntos de muestreo' },
        xRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[graph] rango de x, default [-6,6]' },
        yRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[graph] rango de y (superficies)' },
        vectors: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[vectors] lista de vectores, cualquier dimensión (>3 se proyecta)' },
        labels: { type: 'array', items: { type: 'string' }, description: '[vectors] etiqueta por vector' },
        colors: { type: 'array', items: { type: 'string' }, description: '[vectors] color por vector' },
        origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[vectors] origen de las flechas' },
        showSpan: { type: 'boolean', description: '[vectors] dibuja span(v1,v2) como retícula + plano' },
        point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[plane|line] punto por el que pasa' },
        normal: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[plane] vector normal' },
        u: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[plane] vector director 1 (alternativa a normal)' },
        v: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[plane] vector director 2' },
        direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[line] vector director' },
        length: { type: 'number', description: '[line] longitud dibujada, default 24' },
        arrow: { type: 'boolean', description: '[line] punta de flecha en el extremo positivo' },
      },
    },
    method: 'POST', path: '/api/skills/model3d/show',
  },
  {
    name: 'add_3d',
    description: 'Añade una o más figuras a la escena 3D actual SIN borrar las existentes (mismos campos que show_3d: figura única al nivel superior u objects:[...]). Úsalo para construir composiciones incrementales: "añade otra esfera", "ahora mete un plano". Si el visor está cerrado, lo abre.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: { type: 'array', items: { type: 'object', description: 'Figura — mismos campos que show_3d' }, description: 'Figuras a añadir' },
        kind: { type: 'string', enum: ['parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line'], description: 'Tipo (modo una-sola-figura; el resto de campos como en show_3d)' },
      },
    },
    method: 'POST', path: '/api/skills/model3d/add',
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

  // ---- Distributed agents (remote machines over Tailscale) ----
  // remote_* bridge to /api/agents/*. `transform` reshapes the flat tool args
  // into the hub's { machine, op: { op, params } } RPC envelope.
  {
    name: 'remote_machines',
    description: 'Lista las máquinas remotas (agentes) conectadas al cerebro y sus capacidades. Úsalo antes de un comando remoto para saber qué máquinas hay ("main", etc.) y si están en línea.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/agents/list',
  },
  {
    name: 'remote_sysinfo',
    description: 'Info de sistema (CPU, RAM, disco, uptime) de una máquina remota. Ej: remote_sysinfo(machine="main").',
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' } },
      required: ['machine'],
    },
    method: 'POST', path: '/api/agents/rpc',
    transform: (a) => ({ machine: a.machine, op: { op: 'sys_info' } }),
  },
  {
    name: 'remote_search',
    description: 'Busca archivos por nombre en una máquina remota (Everything en Windows, fallback walkdir). Ej: remote_search(machine="main", query="informe.pdf").',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' },
        query:   { type: 'string', description: 'Texto a buscar en nombres de archivo' },
        max_results: { type: 'integer', minimum: 1, maximum: 500, description: 'Máximo de resultados (opcional)' },
      },
      required: ['machine', 'query'],
    },
    method: 'POST', path: '/api/agents/rpc',
    transform: (a) => ({
      machine: a.machine,
      op: { op: 'search', params: { query: a.query, root: null, max_results: a.max_results ?? null } },
    }),
  },
  {
    name: 'remote_exec',
    description: 'Ejecuta un comando en una máquina remota y devuelve stdout/stderr/exit code. Requiere que el agente tenga exec habilitado en su allowlist local. Ej: remote_exec(machine="main", command="ipconfig").',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' },
        command: { type: 'string', description: 'Ejecutable o comando' },
        args:    { type: 'array', items: { type: 'string' }, description: 'Argumentos (opcional)' },
        timeout_ms: { type: 'integer', minimum: 1000, description: 'Timeout en ms (opcional)' },
      },
      required: ['machine', 'command'],
    },
    method: 'POST', path: '/api/agents/rpc',
    transform: (a) => ({
      machine: a.machine,
      op: { op: 'exec', params: { command: a.command, args: a.args ?? [], cwd: null, timeout_ms: a.timeout_ms ?? null, stream: false } },
    }),
  },
  {
    name: 'remote_read_file',
    description: 'Lee un archivo de una máquina remota y devuelve su contenido (texto UTF-8). Ej: remote_read_file(machine="main", path="C:\\\\Users\\\\santi\\\\nota.txt"). Para archivos grandes usa offset/length.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' },
        path:    { type: 'string', description: 'Ruta absoluta en la máquina remota' },
        offset:  { type: 'integer', minimum: 0, description: 'Byte de inicio (opcional, para paginar)' },
        length:  { type: 'integer', minimum: 1, description: 'Bytes a leer (opcional, máx 4 MiB)' },
      },
      required: ['machine', 'path'],
    },
    method: 'POST', path: '/api/agents/rpc',
    // The agent opens path.raw as-is; `os` is metadata it ignores for fs ops.
    transform: (a) => ({
      machine: a.machine,
      op: { op: 'read_file', params: { path: { raw: a.path, os: a.os ?? 'Windows' }, offset: a.offset ?? null, length: a.length ?? null } },
    }),
    // Decode the base64 payload into text so the model reads the file directly.
    postTransform: (r) => {
      try {
        if (r?.result?.status === 'read_file' && typeof r.result.data_base64 === 'string') {
          r.result.text = Buffer.from(r.result.data_base64, 'base64').toString('utf8')
        }
      } catch { /* leave base64 as-is */ }
      return r
    },
  },
  {
    name: 'remote_write_file',
    description: 'Escribe (crea o sobrescribe) un archivo de texto en una máquina remota. Requiere write_file habilitado en la allowlist del agente. Ej: remote_write_file(machine="main", path="C:\\\\tmp\\\\x.txt", content="hola"). append=true para añadir al final.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' },
        path:    { type: 'string', description: 'Ruta absoluta destino en la máquina remota' },
        content: { type: 'string', description: 'Contenido de texto a escribir' },
        append:  { type: 'boolean', description: 'true = añadir al final; false = sobrescribir (por defecto)' },
      },
      required: ['machine', 'path', 'content'],
    },
    method: 'POST', path: '/api/agents/rpc',
    transform: (a) => ({
      machine: a.machine,
      op: { op: 'write_file', params: { path: { raw: a.path, os: a.os ?? 'Windows' }, data_base64: Buffer.from(a.content ?? '', 'utf8').toString('base64'), append: a.append ?? false } },
    }),
  },
  {
    name: 'remote_wake',
    description: 'Despierta una máquina remota apagada/suspendida por Wake-on-LAN (usa las MACs que el agente registró). Solo funciona si la máquina está en la MISMA red LAN que el portátil (el magic packet no viaja por Tailscale). Ej: remote_wake(machine="main").',
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string', description: 'Nombre de la máquina, ej "main"' } },
      required: ['machine'],
    },
    method: 'POST', path: '/api/agents/wake',
  },
]

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

async function callBackend(tool, args) {
  let url = `${BACKEND}${tool.path}`
  // Tools may reshape flat args into the backend's expected body (e.g. remote_*
  // wrapping into the hub RPC envelope).
  const payload = tool.transform ? tool.transform(args || {}) : (args || {})
  const init = {
    method: tool.method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (tool.method !== 'GET') {
    init.body = JSON.stringify(payload)
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
  return tool.postTransform ? tool.postTransform(data) : data
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
