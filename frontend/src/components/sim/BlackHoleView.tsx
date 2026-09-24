/** Schwarzschild black hole scene.
 *
 *  Nothing here is a texture or an artistic guess:
 *   · the horizon is a black sphere at exactly r = 2M,
 *   · the photon sphere and ISCO are drawn where the geometry puts them (3M, 6M),
 *   · disk particles orbit at the geodesic rate Ω = √(M/r³) — the inner edge
 *     visibly laps the outer one,
 *   · their colour is a blackbody at the Shakura–Sunyaev temperature, shifted by
 *     gravitational redshift AND Doppler beaming toward the CURRENT camera, so
 *     the approaching side really is the bright one and it moves when you orbit,
 *   · the test orbits precess because they are integrated with the 3Mu² term,
 *   · the light rays bend by the amount the null geodesic says they bend, and
 *     the ones below b = 3√3 M are simply absent — that gap IS the shadow,
 *   · y el FONDO estelar se deflecta con esa misma geodésica (`BlackHoleLens`),
 *     que es lo que produce el anillo de Einstein, las imágenes secundarias y
 *     una sombra de 3√3 M de radio aparente — no una esfera negra de 2M.
 */

import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useSimStore } from '../../state/simStore'
import {
  HORIZON, PHOTON_SPHERE, ISCO, B_CRIT,
  traceOrbit, traceRay, orbitalOmega, orbitalSpeed, gravitationalRedshift,
  dopplerFactor, diskTemperature, blackbodyRGB, precessionPerOrbit,
  shadowAngularRadius,
} from '../../lib/sim/schwarzschild'
import { BlackHoleLens } from './BlackHoleLens'
import type { BlackHoleSpec, SimCommon } from '../../lib/sim/types'

const MAX_DISK = 4000
/** Temperature mapped onto the Shakura–Sunyaev profile, in Kelvin.
 *  The profile only varies by ~30 % in T across the visible disk, so the
 *  ENDPOINTS decide whether you see a gradient at all: put the peak above
 *  ~7000 K and every radius lands in the white-blue part of the blackbody
 *  locus and the disk reads as white dust. Anchored here so the inner edge is
 *  white-hot and the outer disk is unmistakably orange. */
const T_FLOOR_K = 900
const T_PEAK_K = 6400

interface Build {
  M: number
  rIn: number
  rOut: number
  particles: number
  viewScale: number
  timeScale: number
  markers: boolean
  relativistic: boolean
  lensing: boolean
  orbits: Array<{ p: number; e: number; color?: string; label?: string }>
  rays: number[]
  title: string
}

/** Un valor del spec que DEBERÍA ser un número.
 *
 *  Quien escribe estos specs es un modelo de lenguaje, así que `"9"` en vez de
 *  `9` no es un caso exótico: es el caso normal en cuanto algo serializa por el
 *  camino. Devuelve `undefined` para lo que no se pueda leer, que es la señal
 *  de "usa el default". */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Un `false` que puede venir como booleano o como la cadena `"false"`.
 *
 *  Mismo origen que `num`: lo que escribe el spec serializa por el camino, y
 *  `spec.disk === false` comparado en estricto contra la cadena `"false"` da
 *  falso — el disco seguía dibujándose después de pedir que se apagara, sin
 *  ningún error que lo delatara. */
function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return undefined
}

/** Lo que el spec traiga como lista, convertido en un array de VERDAD.
 *
 *  Acepta un array, un array serializado en JSON (`"[6,8,10]"`) y cualquier
 *  basura, que cae a `undefined`. Sin esto una cadena atravesaba `buildBlackHole`
 *  intacta y el renderer llamaba `.map` sobre ella: excepción, `Model3DViewer`
 *  descartaba la figura y el agujero negro salía VACÍO, sin más rastro que una
 *  línea en journald. Es exactamente el modo de fallo que `validateModel3dBody`
 *  ya ataja para `dimension`. */
function asArray(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : undefined
    } catch { return undefined }
  }
  return undefined
}

/** Parámetros de impacto: número de rayos, lista explícita, o el default.
 *  GARANTIZA un array — el renderer no tiene otra defensa. */
function resolveRays(raw: unknown): number[] {
  const list = asArray(raw)
  // Una LISTA se respeta tal cual, incluso vacía: `rays: []` es la forma de
  // pedir "ninguno". Sustituirla por el default haría imposible apagarlos, que
  // es justo lo que hay que hacer para mirar solo la lente.
  if (list) return list.map(num).filter((b): b is number => b !== undefined && b > 0)
  const count = num(raw)
  if (count !== undefined) {
    return count <= 0 ? [] : defaultRays(Math.min(64, Math.round(count)))
  }
  return defaultRays()
}

/** Órbitas de prueba. Una entrada sin `p` utilizable se descarta en vez de
 *  producir una rosetta de NaN, que se dibuja como nada y no explica por qué. */
function resolveOrbits(raw: unknown): Build['orbits'] {
  const list = asArray(raw)
  if (!list) return DEFAULT_ORBITS
  // Igual que los rayos: una lista vacía significa ninguna órbita.
  return list.flatMap((o) => {
    if (!o || typeof o !== 'object') return []
    const rec = o as Record<string, unknown>
    const pv = num(rec.p)
    if (pv === undefined || pv <= HORIZON) return []
    const ev = num(rec.e) ?? 0
    return [{
      p: pv,
      e: Math.max(0, Math.min(0.95, ev)),
      color: typeof rec.color === 'string' ? rec.color : undefined,
      label: typeof rec.label === 'string' ? rec.label : undefined,
    }]
  })
}

const DEFAULT_ORBITS: Build['orbits'] = [
  { p: 9, e: 0.25, color: '#7cff6b', label: 'p=9M' },
  { p: 14, e: 0.35, color: '#ffd700', label: 'p=14M' },
]

export function buildBlackHole(spec: BlackHoleSpec & SimCommon): Build {
  const M = num(spec.mass) ?? 1
  const diskOff = bool(spec.disk) === false
  const diskRange = diskOff ? undefined : asArray(spec.disk)
  const disk = diskOff
    ? null
    : [num(diskRange?.[0]) ?? ISCO, num(diskRange?.[1]) ?? 20]
  const rIn = disk ? Math.max(disk[0], HORIZON * 1.05) : ISCO
  const rOut = disk ? Math.max(disk[1], rIn + 1) : 20
  const rays = resolveRays(spec.rays)
  return {
    M,
    rIn, rOut,
    particles: Math.min(MAX_DISK, num(spec.diskParticles) ?? (disk ? 4000 : 0)),
    // Fit the disk (or the ray field) into the viewer's usual ±8 box.
    viewScale: num(spec.viewScale) ?? 8 / (disk ? rOut : 30),
    timeScale: num(spec.timeScale) ?? 12,
    markers: bool(spec.markers) ?? true,
    relativistic: bool(spec.relativistic) ?? true,
    // Una masa 0 o negativa no es un agujero negro: sin ella la lente no tiene
    // nada que doblar y el shader se quedaría sin escala. Se apaga sola.
    lensing: (bool(spec.lensing) ?? true) && M > 0,
    // Apoapsis = p/(1−e) must stay inside the framed region, or the rosette is
    // drawn mostly off screen and the precession it exists to show is invisible.
    orbits: resolveOrbits(spec.orbits),
    rays,
    title: 'Agujero negro de Schwarzschild',
  }
}

/** Impact parameters spread around b_crit, where the bending is dramatic. */
function defaultRays(count = 9): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(B_CRIT * (1.04 + (i / Math.max(1, count - 1)) * 4.2))
  }
  return out
}

export function BlackHoleView({ spec }: { spec: BlackHoleSpec & SimCommon }) {
  const build = useMemo(() => buildBlackHole(spec), [spec])
  const { M, rIn, rOut, particles, viewScale } = build
  const setReadout = useSimStore((s) => s.setReadout)
  const setActive = useSimStore((s) => s.setActive)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    setActive(true, build.title)
    return () => setActive(false)
  }, [build, setActive])

  /* ---- Disk: one Points cloud, positions and colours mutated in place ---- */
  const disk = useMemo(() => {
    const radii = new Float64Array(particles)
    const phase = new Float64Array(particles)
    const omega = new Float64Array(particles)
    const height = new Float32Array(particles)
    const baseRGB = new Float32Array(particles * 3)
    /** g with no line-of-sight motion — the beaming reference at that radius. */
    const refG = new Float64Array(particles)
    let seed = 20260810
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < particles; i++) {
      // Inner-weighted radius (∝1/r surface density, i.e. LINEAR in r between
      // the edges). A uniform-area (√) draw spreads the same particles over the
      // huge outer annulus and the disk reads as scattered dust instead of a
      // disk — and it is the inner region that actually radiates.
      const r = rIn + (rOut - rIn) * rnd() * rnd()
      radii[i] = r
      phase[i] = rnd() * Math.PI * 2
      omega[i] = orbitalOmega(r, M)
      // Thin disk: scale height grows slowly outward.
      height[i] = (rnd() - 0.5) * 0.06 * r
      const t = diskTemperature(r, rIn)
      // Gravitational redshift dims the inner disk; fold it into the base colour
      // so the moving part of the effect is purely the beaming ratio.
      const dim = 0.45 + 0.55 * gravitationalRedshift(r, M)
      const [cr, cg, cb] = blackbodyRGB(T_FLOOR_K + t * T_PEAK_K)
      baseRGB[i * 3] = cr * dim; baseRGB[i * 3 + 1] = cg * dim; baseRGB[i * 3 + 2] = cb * dim
      refG[i] = dopplerFactor(r, 0, M)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particles * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(particles * 3), 3))
    const mat = new THREE.PointsMaterial({
      size: 0.05, vertexColors: true, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })
    return { points: new THREE.Points(geo, mat), radii, phase, omega, height, baseRGB, refG }
  }, [particles, rIn, rOut, M])

  /* ---- Precessing test orbits ---- */
  const orbitLines = useMemo(() => build.orbits.map((o) => {
    const tr = traceOrbit(o.p, o.e, 6, M, 900)
    const pts = new Float32Array(tr.points.length)
    for (let i = 0; i < tr.points.length; i++) pts[i] = tr.points[i] * viewScale
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return {
      line: new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: o.color ?? '#7cff6b', transparent: true, opacity: 0.75,
      })),
      trace: tr,
      spec: o,
    }
  }), [build.orbits, M, viewScale])

  /* ---- Light rays ---- */
  // Rays are clipped to the neighbourhood of the hole: traced out to 60M they
  // are geometrically right and visually useless — long near-straight lines that
  // fill the screen and hide the very bending they are meant to show.
  const rayDraw = Math.min(60, Math.max(12, build.rOut * 1.15))
  const rayLines = useMemo(() => build.rays.map((b) => {
    const tr = traceRay(b, M, 8 * Math.PI, 8000, rayDraw)
    if (tr.captured || tr.points.length < 6) return null
    const pts = new Float32Array(tr.points.length)
    for (let i = 0; i < tr.points.length; i++) pts[i] = tr.points[i] * viewScale
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: '#9fd8ff', transparent: true, opacity: 0.35,
    }))
  }).filter(Boolean) as THREE.Line[], [build.rays, M, viewScale, rayDraw])

  useEffect(() => () => {
    disk.points.geometry.dispose()
    ;(disk.points.material as THREE.Material).dispose()
    for (const o of orbitLines) { o.line.geometry.dispose(); (o.line.material as THREE.Material).dispose() }
    for (const l of rayLines) { l.geometry.dispose(); (l.material as THREE.Material).dispose() }
  }, [disk, orbitLines, rayLines])

  /* ---- Orbiting test masses ---- */
  const marker = useRef<THREE.InstancedMesh>(null)
  const root = useRef<THREE.Group>(null)
  const orbitPhase = useRef<number[]>(build.orbits.map(() => 0))
  const t = useRef(0)
  const lastHud = useRef(0)
  const lastReset = useRef(useSimStore.getState().resetToken)
  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(), v: new THREE.Vector3(),
    q: new THREE.Quaternion(), s: new THREE.Vector3(),
    camDir: new THREE.Vector3(),
    holePos: new THREE.Vector3(), worldScale: new THREE.Vector3(),
  }), [])

  useFrame((_state, delta) => {
    const { playing, speed, resetToken } = useSimStore.getState()
    if (resetToken !== lastReset.current) {
      lastReset.current = resetToken
      t.current = 0
      orbitPhase.current = build.orbits.map(() => 0)
    }
    const dt = playing ? Math.min(delta, 0.1) * speed * build.timeScale : 0
    t.current += dt

    // Camera azimuth in the equatorial (xy math → xz world) plane. The disk is
    // drawn in the math frame, whose z is world y, so the projection differs
    // from the naive one — this is the frame the parent group applies.
    scratch.camDir.set(camera.position.x, camera.position.z, 0)
    const camLen = scratch.camDir.length() || 1
    const camX = scratch.camDir.x / camLen
    const camY = -scratch.camDir.y / camLen

    const pos = disk.points.geometry.getAttribute('position') as THREE.BufferAttribute
    const col = disk.points.geometry.getAttribute('color') as THREE.BufferAttribute
    const pa = pos.array as Float32Array
    const ca = col.array as Float32Array

    for (let i = 0; i < particles; i++) {
      disk.phase[i] += disk.omega[i] * dt
      const a = disk.phase[i]
      const r = disk.radii[i]
      const x = r * Math.cos(a), y = r * Math.sin(a)
      const k = i * 3
      pa[k] = x * viewScale
      pa[k + 1] = y * viewScale
      pa[k + 2] = disk.height[i] * viewScale

      if (build.relativistic) {
        // Velocity direction of a prograde circular orbit is the tangent
        // (−sin a, cos a); its component toward the observer drives the beaming.
        const cosAngle = -Math.sin(a) * camX + Math.cos(a) * camY
        const g = dopplerFactor(r, cosAngle, M)
        // Brightness goes as g⁴, but g itself is < 1 almost everywhere (gravity
        // wins), so applying g⁴ raw pins the whole disk near black except a
        // saturated white crescent — the temperature gradient disappears. What
        // carries the physics is the RATIO to the transverse case at the same
        // radius: that is exactly the beaming asymmetry, with the common
        // redshift factored out into the base colour.
        const ref = disk.refG[i]
        const ratio = ref > 1e-6 ? g / ref : 1
        const boost = Math.min(2.6, Math.max(0.28, ratio * ratio * ratio * ratio))
        ca[k] = Math.min(1, disk.baseRGB[k] * boost)
        ca[k + 1] = Math.min(1, disk.baseRGB[k + 1] * boost)
        ca[k + 2] = Math.min(1, disk.baseRGB[k + 2] * boost)
      } else {
        ca[k] = disk.baseRGB[k]; ca[k + 1] = disk.baseRGB[k + 1]; ca[k + 2] = disk.baseRGB[k + 2]
      }
    }
    pos.needsUpdate = true
    col.needsUpdate = true

    // Test masses walk along their precomputed precessing tracks.
    const mk = marker.current
    if (mk) {
      for (let i = 0; i < orbitLines.length; i++) {
        const tr = orbitLines[i].trace
        const n = tr.points.length / 3
        if (n < 2) continue
        // Angular rate at the current radius keeps the pace physical rather
        // than uniform-in-index (which would crawl at perihelion).
        orbitPhase.current[i] += dt * 0.9
        const idx = Math.floor(orbitPhase.current[i] * 26) % n
        const k = idx * 3
        scratch.v.set(tr.points[k] * viewScale, tr.points[k + 1] * viewScale, tr.points[k + 2] * viewScale)
        scratch.s.setScalar(0.13)
        scratch.m.compose(scratch.v, scratch.q, scratch.s)
        mk.setMatrixAt(i, scratch.m)
      }
      mk.instanceMatrix.needsUpdate = true
    }

    const now = performance.now()
    if (now - lastHud.current > 250) {
      lastHud.current = now
      const rows: Array<[string, string]> = [
        ['Horizonte', `r = 2M = ${(HORIZON * M).toFixed(1)} M`],
        ['Esfera de fotones', `r = 3M · captura en b = 3√3 M = ${(B_CRIT * M).toFixed(2)} M`],
        ['ISCO', `r = 6M · v_orbital = ${(orbitalSpeed(ISCO * M, M) * 100).toFixed(0)} % c`],
        ['Disco', `${rIn.toFixed(1)}M → ${rOut.toFixed(1)}M · ${particles} partículas`],
      ]
      for (const o of build.orbits) {
        rows.push([
          `Precesión ${o.label ?? `p=${o.p}M`}`,
          `${((precessionPerOrbit(o.p, M) * 180) / Math.PI).toFixed(1)}° por órbita`,
        ])
      }
      if (build.lensing && root.current) {
        // Distancia de la cámara en unidades de M, leída de la transformación
        // REAL del grupo: el visor puede haberle puesto posición y escala.
        scratch.holePos.setFromMatrixPosition(root.current.matrixWorld)
        scratch.worldScale.setFromMatrixScale(root.current.matrixWorld)
        const perM = Math.max(1e-9, M * viewScale * scratch.worldScale.x)
        const DM = camera.position.distanceTo(scratch.holePos) / perM
        const sh = shadowAngularRadius(DM, 1)
        rows.push([
          'Sombra',
          isFinite(sh)
            ? `${((sh * 360) / Math.PI).toFixed(1)}° de diámetro desde r = ${DM.toFixed(0)} M`
            : 'cámara dentro del horizonte',
        ])
      }
      rows.push(['t', `${t.current.toFixed(0)} M`])
      setReadout(rows)
    }
  })

  const s = viewScale
  return (
    <group ref={root}>
      {/* Fondo lensado. Va PRIMERO y sin escribir profundidad: pinta el cielo
          deflectado bajo toda la escena, incluida la sombra, y el disco y las
          órbitas se dibujan encima con normalidad. */}
      {build.lensing && <BlackHoleLens mass={M} viewScale={viewScale} />}

      {/* Event horizon — genuinely black, and it occludes the disk behind it. */}
      <mesh>
        <sphereGeometry args={[HORIZON * M * s, 48, 32]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {build.markers && (
        <>
          {/* Photon sphere */}
          <mesh>
            <sphereGeometry args={[PHOTON_SPHERE * M * s, 32, 24]} />
            <meshBasicMaterial color="#5fd8ff" wireframe transparent opacity={0.05} />
          </mesh>
          {/* ISCO ring, in the equatorial plane */}
          <mesh>
            <ringGeometry args={[ISCO * M * s * 0.995, ISCO * M * s * 1.005, 128]} />
            <meshBasicMaterial color="#ffd700" transparent opacity={0.5} side={THREE.DoubleSide} />
          </mesh>
        </>
      )}

      <primitive object={disk.points} />
      {orbitLines.map((o, i) => <primitive key={`o${i}`} object={o.line} />)}
      {rayLines.map((l, i) => <primitive key={`r${i}`} object={l} />)}

      {/* Solo si hay órbitas que marcar. El `Math.max(1, ...)` de antes
          reservaba una instancia igualmente, y su matriz se quedaba en
          IDENTIDAD: una esfera BLANCA de radio 1 en el origen, o sea justo
          encima del agujero negro, tapándolo entero. No se veía porque hasta
          ahora era imposible pedir cero órbitas — el resolver sustituía la
          lista vacía por el par de defecto. */}
      {orbitLines.length > 0 && (
        <instancedMesh ref={marker} args={[undefined, undefined, orbitLines.length]} frustumCulled={false}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshBasicMaterial color="#ffffff" />
        </instancedMesh>
      )}
    </group>
  )
}
