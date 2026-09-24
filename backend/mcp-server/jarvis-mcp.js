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
    description: 'Abre una vista del ring de Jarvis. Modos disponibles: home (centro de mando), house (casa/Stark Tower), plan2d (plano 2D), plan3d (plano 3D navegable), space (vista inmersiva primera persona), cloud (nube familiar), system (telemetría + config móvil), utils (sub-ring de utilidades), timer (temporizadores), chrono (cronómetros), vault (grafo 3D de conocimiento: bóveda, memoria y conversaciones).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['home','house','plan2d','plan3d','space','cloud','system','mobile','utils','timer','chrono','vault'],
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
    name: 'system_clipboard',
    description: 'Lee o escribe el portapapeles del PC. action: get (devuelve el texto copiado — para "resume/traduce/explica lo que copié"), set (copia text al portapapeles — para "cópiame eso", "déjame el comando copiado"). Si el portapapeles tiene una imagen, get lo dice sin devolver texto.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        text: { type: 'string', description: 'Texto a copiar (para action=set).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/clipboard',
  },
  {
    name: 'system_media',
    description: 'Controla la música/vídeo que suena en el PC (Spotify, navegador, mpv…). action: status (qué suena), play, pause, toggle (pausa/reanuda), next (siguiente), previous (anterior). Prefiere el reproductor local sobre el del móvil. "pausa la música"→pause, "siguiente canción"→next, "qué está sonando"→status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'play', 'pause', 'toggle', 'next', 'previous'] },
        player: { type: 'string', description: 'Opcional: nombre parcial del reproductor (spotify, firefox).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/media',
  },
  {
    name: 'system_window',
    description: 'Gestiona ventanas y escritorios (Hyprland). action: list (ventanas abiertas), active (ventana enfocada), focus (traer target al frente), workspace (ir al escritorio workspace), move (mover target — o la enfocada — al escritorio workspace), close (cerrar target o la enfocada), fullscreen (alternar pantalla completa de la enfocada). target = nombre de la app o parte del título. "ve al escritorio 3"→workspace 3, "trae el navegador"→focus target="brave", "manda spotify al 5"→move, "cierra esta ventana"→close sin target.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'active', 'focus', 'workspace', 'move', 'close', 'fullscreen'] },
        target: { type: 'string', description: 'App o título de la ventana (focus/move/close).' },
        workspace: { type: 'string', description: 'Número de escritorio, o +1/-1 relativo (workspace/move).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/window',
  },
  {
    name: 'system_dnd',
    description: 'Modo no molestar de las notificaciones del escritorio. action: on, off, toggle, status. Úsalo para sesiones de estudio o concentración ("no me distraigas", "modo foco").',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['on', 'off', 'toggle', 'status'] } },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/system/dnd',
  },
  {
    name: 'study_session',
    description: 'Sesión de estudio tipo pomodoro. action: start (subject = materia; focus_minutes default 25, break_minutes default 5, cycles default 4), stop, status. Al iniciar activa no molestar y muestra la cuenta atrás; Jarvis anuncia solo cada fin de bloque y de descanso, y registra el tiempo estudiado. "vamos a estudiar física una hora"→start subject="física" cycles=2; "pomodoro de 50 y 10"→focus_minutes=50 break_minutes=10; "cuánto me queda"→status; "ya terminé"→stop.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'] },
        subject: { type: 'string', description: 'Materia o tema (start).' },
        focus_minutes: { type: 'integer', description: 'Minutos de cada bloque de foco.' },
        break_minutes: { type: 'integer', description: 'Minutos de cada descanso.' },
        cycles: { type: 'integer', description: 'Número de bloques de foco.' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/study/session',
  },
  {
    name: 'flashcards',
    description: 'Tarjetas de repaso con repetición espaciada (SM-2). action: add (cards=[{front,back}] en deck — úsalo para crear tarjetas de una explicación o de una nota), due (tarjetas pendientes hoy, opcional deck), grade (id + grade 0-5 tras oír la respuesta del señor: 5 perfecta, 4 correcta dudando, 3 correcta con esfuerzo, 0-2 incorrecta), stats (cuántas hay y pendientes por mazo), delete (id). front es una pregunta corta que se pueda decir en voz; back la respuesta esencial.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'due', 'grade', 'stats', 'delete'] },
        deck: { type: 'string', description: 'Mazo/materia (ej. "electromagnetismo").' },
        cards: {
          type: 'array',
          items: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } }, required: ['front', 'back'] },
          description: 'Tarjetas a crear (add).',
        },
        id: { type: 'integer', description: 'Id de la tarjeta (grade/delete).' },
        grade: { type: 'integer', minimum: 0, maximum: 5, description: 'Calidad de la respuesta (grade).' },
        limit: { type: 'integer', description: 'Máximo de tarjetas (due, default 10).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/study/cards',
  },
  {
    name: 'habit',
    description: 'Registro de hábitos con rachas. action: log (habit = nombre corto y estable, ej "ejercicio", "lectura", "dormir temprano"; note opcional), status (todos los hábitos: hecho hoy, racha, días de la última semana). "ya entrené"→log habit="ejercicio"; "leí 30 páginas"→log habit="lectura" note="30 páginas"; "cómo voy con mis hábitos"→status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['log', 'status'] },
        habit: { type: 'string', description: 'Nombre del hábito (log). Reutiliza el mismo nombre siempre.' },
        note: { type: 'string', description: 'Detalle opcional (log).' },
      },
      required: ['action'],
    },
    method: 'POST', path: '/api/skills/habit',
  },
  {
    name: 'day_brief',
    description: 'Estado del día del señor en una sola lectura: tareas de hoy (abiertas/hechas y arrastradas de días anteriores), recordatorios de hoy, tarjetas de repaso pendientes, minutos estudiados hoy y en la semana, sesión de estudio en curso y hábitos con racha. Úsalo para "qué tengo hoy", "cómo va mi día", "planeemos el día" y para la revisión de la noche ("qué hice hoy").',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/day/brief',
  },
  {
    name: 'obsidian_task_done',
    description: 'Marca como hecha una tarea abierta de las notas diarias (busca en los últimos 7 días). text = la tarea tal como la dijo el señor (basta una parte). Si responde "ambigua", pregunta cuál de las opciones.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Texto (o parte) de la tarea completada.' } },
      required: ['text'],
    },
    method: 'POST', path: '/api/skills/obsidian/task/done',
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

  /* ----- Grafo de conocimiento ----- */
  {
    name: 'vault_graph',
    description: 'Devuelve el grafo de conocimiento (notas de la bóveda, memoria y conversaciones) con sus enlaces. Úsalo para responder qué sabe Jarvis sobre un tema y cómo se relaciona.',
    inputSchema: {
      type: 'object',
      properties: {
        facts:         { type: 'boolean', description: 'Incluir la memoria a largo plazo (por defecto sí)' },
        conversations: { type: 'boolean', description: 'Incluir las conversaciones recientes (por defecto sí)' },
        tags:          { type: 'boolean', description: 'Promover los tags a nodos propios (por defecto no)' },
      },
    },
    method: 'GET', path: '/api/skills/vault/graph',
  },
  {
    name: 'vault_focus',
    description: 'Enfoca un nodo concreto del grafo 3D en pantalla (una nota, un recuerdo o una conversación). Requiere que la interfaz esté despierta.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Id o nombre del nodo, ej "02-Proyectos/Jarvis" o "fact:12"' },
      },
      required: ['node'],
    },
    method: 'POST', path: '/api/skills/vault/focus',
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
KINDS: "primitive" (sólidos exactos shape=sphere|box|cylinder|cone|torus — para composiciones con tangencia/contención precisas), "parametric" (superficie x/y/z en u,v, mathjs), "polytope" (hipercubo/cross N-D animado, caras translúcidas y color por 4ª coordenada), "implicit" (isosuperficie f(x,y,z)=isoValue por marching cubes — Fermi, gyroides), "graph" (y=f(x) curva o z=f(x,y) superficie, autodetecta si f usa y), "curve" (curva paramétrica x(t),y(t),z(t)), "vectors" (flechas n-D proyectadas a R³, showSpan dibuja el span de v1,v2), "plane" (plano por normal+point o vectores u,v), "line" (recta point+direction), "polygon" (lista EXPLÍCITA de vértices [[x,y,z],...]; con height se extruye a lo largo de la normal del plano de ajuste → prisma/caja/cilindro, y capScale:0 lo cierra en punta → pirámide/cono.), "simulation" (SIMULACIÓN FÍSICA con tiempo real, ver abajo).
SIMULATION — para todo lo que se MUEVE y debe ser preciso; el visor trae reproductor (play/pausa/velocidad/reinicio) y HUD con magnitudes físicas. Campo obligatorio: system.
 · system:"nbody" — mecánica orbital. preset: solar|inner|outer|earth-moon|jupiter-moons|binary|figure8|lagrange|trappist. mode:"kepler" (elipses analíticas exactas, admite startDate ISO y muestra la FECHA simulada) o "nbody" (atracción mutua real con Verlet simpléctico, muestra perturbaciones y deriva de energía). También bodies:[{name,mass,position,velocity,radius,color}] en AU/días/masas solares. En modo nbody y unidades solares van ENCENDIDAS por defecto la corrección relativista 1PN (Mercurio precesa 43"/siglo de verdad) y el achatamiento J2 (el bulto de Júpiter hace regresar los nodos de sus lunas); se apagan con relativistic:false / oblateness:false. collisions:true hace que dos cuerpos que se TOQUEN se fundan conservando masa y momento (apagado por defecto: en el sistema solar real nada choca). Los cuerpos se pintan con textura real, eje inclinado, rotación propia y anillos, y proyectan SOMBRA — un eclipse de Luna se ve; realistic:false vuelve al modo esquemático de esferas de color.
 · system:"blackhole" — Schwarzschild. mass (en M), disk:[rIn,rOut] en M, diskParticles, orbits:[{p,e}] (órbitas de prueba que PRECESAN de verdad), rays (parámetros de impacto de rayos de luz que se curvan; por debajo de 3√3 M caen y esa ausencia es la sombra). Horizonte 2M, esfera de fotones 3M, ISCO 6M; el disco orbita a √(M/r³) y se colorea con cuerpo negro + corrimiento gravitacional + Doppler relativista hacia la cámara. lensing (default sí) deflecta el fondo estelar con la misma geodésica nula: aparecen el anillo de Einstein y la imagen secundaria.
 · system:"dynamics" — partículas newtonianas con fuerzas que SE SUMAN: gravity, drag, dragQuadratic, spring:{k,anchor,restLength}, eField/bField (Lorentz), mutualGravity, force:{fx,fy,fz} en mathjs con x,y,z,vx,vy,vz,t,m,q,r,speed. floor/box/restitution/stopOnFloor para choques. vectors:["velocity","acceleration","force","momentum"] dibuja FLECHAS VIVAS sobre cada partícula. preset: projectile|spring|cyclotron|orbit|collision.
 · system:"field" — campo vectorial fx,fy,fz(x,y,z,t): flechas coloreadas por magnitud, streamlines y tracers arrastrados por el campo. preset: dipole|vortex|source|wire|saddle|wave. plane:"xy" para cortar a un plano.
 · system:"ode" — sistema dinámico cualquiera: vars:["x","y","z"], d:["10*(y-x)",...], init:[[...],[...]]; axes acepta EXPRESIONES para dibujar en el espacio que quieras. preset: lorenz|rossler|van-der-pol|double-pendulum|chua.
 Comunes: dt (paso fijo), timeScale (unidades de simulación por segundo real), trail (longitud de estela), viewScale, paused.
EJEMPLOS. Esferas concéntricas: {objects:[{kind:"primitive",shape:"sphere",radius:1,color:"#38d5ff",opacity:0.55},{kind:"primitive",shape:"sphere",radius:1.6,color:"#ff5f8f",opacity:0.3}]}. Cubo inscrito en cilindro (esquinas tocando la pared: radio=(lado/2)*sqrt(2)): {objects:[{kind:"primitive",shape:"cylinder",radius:1.4142,height:2,opacity:0.3},{kind:"primitive",shape:"box",size:[2,2,2],color:"#7cff6b",opacity:0.7}]}. Esferas tangentes: distancia entre centros = r1+r2 (usa position). Teseracto: {kind:"polytope",type:"hypercube",dimension:4,faces:true,speed:1}. Gráfica: {kind:"graph",f:"sin(x)/x",xRange:[-10,10]} (superficie: f:"sin(x)*cos(y)" + yRange). Espacio vectorial: {kind:"vectors",vectors:[[2,1,0],[0,1,2]],labels:["v1","v2"],showSpan:true} (vectores de dimensión >3 se proyectan). Recta: {kind:"line",point:[0,0,1],direction:[1,2,0]}. Plano: {kind:"plane",normal:[1,1,1]}. Fermi del cobre: {kind:"implicit",f:"-(cos(x)*cos(y)+cos(y)*cos(z)+cos(z)*cos(x))",isoValue:-0.5,bounds:[-3.1416,3.1416],brillouinZone:"fcc"}. Sistema solar de HOY: {kind:"simulation",system:"nbody",preset:"solar"}. En una fecha: {kind:"simulation",system:"nbody",preset:"solar",mode:"kepler",startDate:"2027-03-21"}. Agujero negro: {kind:"simulation",system:"blackhole",orbits:[{p:14,e:0.35}],rays:9}. Tierra-Luna con sombras reales: {kind:"simulation",system:"nbody",preset:"earth-moon"} (la Luna se eclipsa al cruzar el cono de sombra terrestre, que con su inclinación real de 5.145° solo pasa cerca de los nodos — igual que de verdad). Precesión de Mercurio: {kind:"simulation",system:"nbody",preset:"inner",mode:"nbody",trail:3000}. Choque de asteroides: {kind:"simulation",system:"dynamics",preset:"collision"}. Tiro parabólico con vectores: {kind:"simulation",system:"dynamics",preset:"projectile"}. Carga en campo magnético: {kind:"simulation",system:"dynamics",bField:[0,0,1.5],particles:[{position:[1.5,0,-2],velocity:[0,2.2,0.7],charge:1}],vectors:["velocity","force"]}. Dipolo eléctrico: {kind:"simulation",system:"field",preset:"dipole"}. Lorenz: {kind:"simulation",system:"ode",preset:"lorenz"}. Para pausar/acelerar lo que ya corre usa sim_control (NO vuelvas a llamar show_3d: eso reinicia la física).
Para añadir sin borrar usa add_3d; para cerrar, hide_3d.`,
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
        kind: { type: 'string', enum: ['parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line', 'polygon', 'simulation'], description: 'Tipo de figura (modo una-sola-figura)' },
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
        vertices: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[polygon] vértices [[x,y,z],...] en coordenadas matemáticas (z arriba). La escena son DECÍMETROS: 1 unidad = 10 cm' },
        closed: { type: 'boolean', description: '[polygon] cerrar el contorno (default true)' },
        fill: { type: 'boolean', description: '[polygon] rellenar la cara (default true)' },
        height: { type: 'number', description: '[polygon] extruir esta distancia a lo largo de la normal del plano de ajuste' },
        capScale: { type: 'number', description: '[polygon] tamaño de la tapa respecto a la base (default 1; 0 = punta → pirámide/cono)' },
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
        system: { type: 'string', enum: ['nbody', 'blackhole', 'dynamics', 'field', 'ode'], description: '[simulation] qué se simula (OBLIGATORIO con kind:"simulation")' },
        preset: { type: 'string', description: '[simulation] escenario listo: nbody→solar|inner|outer|earth-moon|jupiter-moons|binary|figure8|lagrange|trappist · dynamics→projectile|spring|cyclotron|orbit|collision · field→dipole|vortex|source|wire|saddle|wave · ode→lorenz|rossler|van-der-pol|double-pendulum|chua' },
        mode: { type: 'string', enum: ['kepler', 'nbody'], description: '[simulation nbody] kepler = elipses exactas por fecha; nbody = atracción mutua integrada' },
        startDate: { type: 'string', description: '[simulation nbody, modo kepler] fecha ISO de partida, ej "2027-03-21"' },
        bodies: { type: 'array', items: { type: 'object' }, description: '[simulation nbody] cuerpos {name,mass,position,velocity,radius,color} en AU/días/masas solares' },
        showOrbits: { type: 'boolean', description: '[simulation nbody] dibuja la elipse de cada cuerpo' },
        softening: { type: 'number', description: '[simulation nbody] suavizado de Plummer para pasos cercanos' },
        mass: { type: 'number', description: '[simulation blackhole] masa en unidades geométricas (horizonte = 2M)' },
        disk: { anyOf: [{ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, { type: 'boolean' }], description: '[simulation blackhole] disco de acreción [rIn,rOut] en M, o false' },
        diskParticles: { type: 'integer', description: '[simulation blackhole] partículas del disco (tope 4000)' },
        orbits: { type: 'array', items: { type: 'object' }, description: '[simulation blackhole] órbitas de prueba [{p,e,color,label}] — precesan de verdad' },
        rays: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'number' } }], description: '[simulation blackhole] rayos de luz: número, o parámetros de impacto en M' },
        relativistic: { type: 'boolean', description: '[simulation] blackhole: Doppler + corrimiento gravitacional en el disco. nbody: corrección 1PN, la que hace precesar a Mercurio. Default sí en ambos (en nbody, solo integrando y en unidades solares)' },
        oblateness: { type: 'boolean', description: '[simulation nbody] achatamiento J2 de los cuerpos tabulados — hace regresar los nodos de las lunas de Júpiter (default sí)' },
        collisions: { type: 'boolean', description: '[simulation nbody] dos cuerpos que se tocan se FUNDEN conservando masa y momento (default no). [simulation dynamics] las partículas chocan entre sí en vez de atravesarse' },
        lensing: { type: 'boolean', description: '[simulation blackhole] lente gravitacional del fondo estelar: anillo de Einstein e imagen secundaria (default sí)' },
        friction: { type: 'number', description: '[simulation dynamics] rozamiento de Coulomb contra suelo y paredes: lo que cae RUEDA hasta pararse' },
        realistic: { type: 'boolean', description: '[simulation] texturas planetarias, iluminación física y fondo estelar (default sí). false = modo esquemático de esferas de color' },
        starfield: { type: 'boolean', description: '[simulation] fondo de Vía Láctea (default: sigue a realistic)' },
        shadows: { type: 'boolean', description: '[simulation] sombras proyectadas = eclipses reales (default sí con 12 cuerpos o menos)' },
        particles: { type: 'array', items: { type: 'object' }, description: '[simulation dynamics] {position,velocity,mass,charge,radius,color,fixed}' },
        force: { type: 'object', description: '[simulation dynamics] {fx,fy,fz} mathjs en x,y,z,vx,vy,vz,t,m,q,r,speed' },
        gravity: { type: 'number', description: '[simulation dynamics] gravedad uniforme hacia -z (9.81 = Tierra)' },
        drag: { type: 'number', description: '[simulation dynamics] rozamiento lineal F=-k·v' },
        dragQuadratic: { type: 'number', description: '[simulation dynamics] rozamiento cuadrático' },
        spring: { type: 'object', description: '[simulation dynamics] {k,anchor,restLength}' },
        eField: { type: 'array', items: {}, description: '[simulation dynamics] campo eléctrico [Ex,Ey,Ez] (números o expresiones)' },
        bField: { type: 'array', items: {}, description: '[simulation dynamics] campo magnético [Bx,By,Bz] (números o expresiones)' },
        mutualGravity: { type: 'number', description: '[simulation dynamics] G para la atracción entre las propias partículas' },
        floor: { type: 'number', description: '[simulation dynamics] altura del suelo' },
        box: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[simulation dynamics] semiejes de la caja de choques' },
        restitution: { type: 'number', description: '[simulation dynamics] 1 = choque elástico' },
        stopOnFloor: { type: 'boolean', description: '[simulation dynamics] el suelo absorbe el impacto (para comparar alcances)' },
        fx: { type: 'string', description: '[simulation field] componente x del campo, mathjs en x,y,z,t,r' },
        fy: { type: 'string', description: '[simulation field] componente y' },
        fz: { type: 'string', description: '[simulation field] componente z' },
        extent: { type: 'number', description: '[simulation field] semilado de la caja de muestreo' },
        density: { type: 'integer', description: '[simulation field] flechas por eje (tope 12)' },
        plane: { type: 'string', enum: ['xy', 'xz', 'yz'], description: '[simulation field] corta las flechas a un plano' },
        tracers: { type: 'integer', description: '[simulation field] partículas arrastradas por el campo' },
        streamlines: { type: 'integer', description: '[simulation field] líneas de campo' },
        vars: { type: 'array', items: { type: 'string' }, description: '[simulation ode] nombres de las variables de estado' },
        d: { type: 'array', items: { type: 'string' }, description: '[simulation ode] derivada de cada variable, en mathjs' },
        init: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[simulation ode] una fila por trayectoria' },
        axes: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: '[simulation ode] expresiones dibujadas en x,y,z' },
        vectors: { type: 'array', items: { type: 'string', enum: ['velocity', 'acceleration', 'force', 'momentum'] }, description: '[simulation dynamics] flechas vivas sobre cada partícula' },
        dt: { type: 'number', description: '[simulation] paso fijo de integración' },
        timeScale: { type: 'number', description: '[simulation] unidades de simulación por segundo real' },
        trail: { anyOf: [{ type: 'integer' }, { type: 'boolean' }], description: '[simulation] longitud de la estela (false = sin estela)' },
        viewScale: { type: 'number', description: '[simulation] unidades de escena por unidad física' },
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
        kind: { type: 'string', enum: ['parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line', 'polygon', 'simulation'], description: 'Tipo (modo una-sola-figura; el resto de campos como en show_3d)' },
      },
    },
    method: 'POST', path: '/api/skills/model3d/add',
  },
  {
    name: 'sim_control',
    description: 'Controla la simulación que YA está corriendo en el visor 3D: pausar, reanudar, cambiar la velocidad o reiniciarla desde las condiciones iniciales. Úsalo para "para eso", "más rápido", "cámara lenta", "vuelve a empezar". NUNCA uses show_3d para pausar — eso reconstruye la escena y reinicia la física.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'toggle', 'reset', 'speed'], description: 'Qué hacer (default: toggle)' },
        speed: { type: 'number', description: 'Multiplicador de velocidad cuando action="speed" (1 = tiempo normal de la escena, 0.1 = cámara lenta, 30 = muy rápido)' },
      },
    },
    method: 'POST', path: '/api/skills/model3d/sim',
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
  {
    name: 'projector_show',
    description: 'Enciende el proyector y proyecta en la pared el escritorio de este portátil (Moonlight sobre WiFi). Hace todo el proceso: encendido, espera de arranque y lanzamiento del stream. Es idempotente — si ya está proyectando no hace nada. Úsalo para "proyecta", "pon esto en la pared", "enciende el proyector".',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Manda el pulso de encendido aunque el proyector ya responda (úsalo solo si está encendido pero mostrando otra cosa)' },
      },
    },
    method: 'POST', path: '/api/skills/projector/on',
  },
  {
    name: 'projector_off',
    description: 'Cierra el stream y apaga el proyector. Úsalo para "apaga el proyector", "quita eso de la pared".',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/projector/off',
  },
  {
    name: 'projector_status',
    description: 'Estado del proyector: si responde, si la pantalla está encendida, si tiene Moonlight instalado y si hay comando de encendido configurado.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/projector/status',
  },
  {
    name: 'rgb_set',
    description: 'Cambia color RGB del PC (RAM/placa/fans/AIO) y/o teclado.',
    inputSchema: {
      type: 'object',
      properties: {
        color:  { type: 'string', description: 'nombre (red,blue,gold...) o hex #RRGGBB' },
        target: { type: 'string', enum: ['all', 'pc', 'keyboard'], description: 'default: all' },
      },
      required: ['color'],
    },
    method: 'POST', path: '/api/skills/rgb/set',
    // Respuesta mínima: el backend ya devuelve "OK" o la primera línea de error.
    postTransform: (r) => r.result ?? 'OK',
  },
  {
    name: 'rgb_preset',
    description: 'Aplica un preset de RGB guardado (color+targets+efectos) por nombre.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'nombre exacto del preset guardado' },
      },
      required: ['name'],
    },
    method: 'POST', path: '/api/skills/rgb/preset',
    postTransform: (r) => r.result ?? 'OK',
  },

  /* ----- AUTODESARROLLO: Jarvis modifica su propio código ----- */
  {
    name: 'code_task',
    description: 'Encarga un cambio en el CÓDIGO FUENTE de Jarvis a un agente de programación completo (Claude Code) que trabaja en el repositorio: lee, edita, corre los tests, y el sistema reconstruye y reinicia los servicios afectados al terminar. ÚSALA siempre que el señor pida modificar, arreglar, mejorar, añadir o quitar algo de TI MISMO o de tu código (backend, frontend, servicios de voz, herramientas). Antes se toma un punto de restauración de git automáticamente. Es ASÍNCRONA: devuelve un jobId al instante y el trabajo tarda minutos; avisa al señor de que le informarás al terminar y NO esperes el resultado en el mismo turno. Pasa la instrucción COMPLETA y literal de lo que pidió, con todo el detalle que dio.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Qué debe cambiarse, en español y con el máximo detalle que dio el señor.' },
        model: { type: 'string', description: 'Modelo del agente: sonnet (default) u opus para cambios delicados o de arquitectura.' },
      },
      required: ['instruction'],
    },
    method: 'POST', path: '/api/skills/code/task',
  },
  {
    name: 'code_task_status',
    description: 'Consulta el estado de los cambios de código encargados con code_task. Sin id devuelve el trabajo activo y los últimos. Con id devuelve ese trabajo: status (running, applying, done, failed), resumen, archivos cambiados y qué servicios se reiniciaron. Úsala cuando el señor pregunte "¿cómo vas con el cambio?" o "¿terminaste?".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'jobId devuelto por code_task (opcional).' },
        log: { type: 'boolean', description: 'true para incluir la cola del log de la ejecución (solo para diagnosticar fallos).' },
      },
    },
    method: 'POST', path: '/api/skills/code/task/status',
  },
  {
    name: 'code_run',
    description: 'Ejecuta un comando de shell DENTRO del repositorio de Jarvis (tests, git status, npm run build, systemctl status). Para acciones del sistema fuera del repo usa run_terminal. Devuelve stdout, stderr y código de salida.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando de shell.' },
        cwd: { type: 'string', description: 'Directorio (opcional; por defecto la raíz del repositorio).' },
        timeoutMs: { type: 'integer', description: 'Timeout en ms (opcional, default 120000, máx 600000).' },
      },
      required: ['command'],
    },
    method: 'POST', path: '/api/skills/code/run',
  },
  {
    name: 'code_checkpoint',
    description: 'Crea un punto de restauración de git del código de Jarvis antes de tocar nada. code_task ya lo hace solo; úsala solo para checkpoints manuales.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Etiqueta del punto de control.' } },
    },
    method: 'POST', path: '/api/skills/code/checkpoint',
  },
  {
    name: 'code_rollback',
    description: 'Revierte el código de Jarvis al último punto de restauración (o al sha indicado). DESTRUCTIVO: descarta los cambios posteriores. Úsala cuando el señor diga que un cambio salió mal o pida deshacerlo. Confirma en voz antes de llamarla.',
    inputSchema: {
      type: 'object',
      properties: { sha: { type: 'string', description: 'Commit al que volver (opcional; por defecto el último checkpoint).' } },
    },
    method: 'POST', path: '/api/skills/code/rollback',
  },
  {
    name: 'code_restart',
    description: 'Reinicia el backend de Jarvis para aplicar cambios de código ya escritos. code_task lo hace solo al terminar; úsala solo si el señor lo pide explícitamente.',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/code/restart',
  },

  {
    name: 'look_screen',
    description: 'MIRA la pantalla del señor y devuelve lo que se ve como imagen. Úsala cuando pregunte por algo que está en pantalla: un error, un mensaje, un documento, "¿qué dice ahí?", "lee esto", "¿qué ves?". Devuelve una captura real que tú puedes leer.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', description: 'Nombre del monitor (eDP-1 = portátil, projmap = proyector). Vacío = el principal.' },
      },
    },
    method: 'POST', path: '/api/skills/vision/screen', image: true,
  },
  {
    name: 'look_camera',
    description: 'MIRA por la cámara y devuelve la foto como imagen. Úsala cuando el señor pregunte por algo del mundo físico delante de él: "¿qué es esto?", "¿ves lo que tengo en la mano?". Requiere la interfaz despierta.',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/vision/camera', image: true,
  },
  {
    name: 'speak',
    description: 'Di algo en voz alta por los altavoces, sin esperar a que el señor pregunte. Úsala solo para avisos que de verdad merecen interrumpir; tu respuesta normal de cada turno ya se dice sola y NO necesita esta herramienta.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Frase corta en español, sin símbolos.' } },
      required: ['text'],
    },
    method: 'POST', path: '/api/skills/speech/say',
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
    headers: {
      'Content-Type': 'application/json',
      // Marks this request as a MODEL tool call, so the backend can apply the
      // per-speaker risk policy to it (see lib/toolRisk.js). GUI and companion
      // traffic hits the same routes and must NOT be gated by whoever spoke
      // last, so the header is what separates the two.
      'X-Jarvis-Origin': 'model',
      'X-Jarvis-Tool': tool.name,
    },
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
    // Vision tools must come back as an IMAGE block: a base64 string inside a
    // text block is just a wall of characters the model cannot look at.
    if (tool.image && result?.image?.base64) {
      return {
        content: [
          { type: 'image', data: result.image.base64, mimeType: result.image.mimeType || 'image/jpeg' },
        ],
      }
    }
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
