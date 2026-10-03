import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard } from '@react-three/drei'
import * as THREE from 'three'
import { HUE } from '../lib/theme'

/* ─────────────────────────────────────────────────────────────
   Kit holográfico del anillo.

   Todo el "brillo" es FALSO a propósito: sin postprocesado. Un bloom real
   pide un render target + varias pasadas de blur por frame, y en este
   WebKitGTK sobre iGPU eso compite con MediaPipe por el mismo hilo (ver
   CLAUDE.md, gestos). En su lugar: shaders aditivos baratos — fresnel para
   el borde, halos de sprite para el resplandor, y un pedestal que dibuja
   anillos, ticks y radar en UN solo quad.

   Los hues salen de theme.ts: el color sigue significando algo. Base cyan
   (`info`) + azul de sombra (`deep`); nada de acentos decorativos.
───────────────────────────────────────────────────────────── */

/** Reloj compartido por todos los shaders del kit (un solo objeto uniform). */
export const HOLO_TIME = { value: 0 }

/** Lo avanza UNA vez por frame. Montar una sola vez dentro del Canvas. */
export function HoloClock() {
  useFrame(state => { HOLO_TIME.value = state.clock.elapsedTime })
  return null
}

/** Los adornos no deben agrandar la zona clicable del holograma. */
const noRaycast = () => null

/* ── Material holográfico ──────────────────────────────────────
   Fresnel (borde brillante, centro casi transparente) × scanlines en Y de
   mundo × banda de escaneo que sube × parpadeo sutil. Aditivo, sin escribir
   profundidad: se superpone como luz, no como superficie.

   Expone `opacity` como accesor sobre el uniform, así el disolvido del pinch
   (RingHologram recorre los materiales y escribe `.opacity`) funciona igual
   que con los materiales estándar. */
const HOLO_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vView = -mv.xyz;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`
const HOLO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uIntensity;
  uniform float uRim;
  uniform float uFill;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vWorld;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), uRim);
    float lines = 0.62 + 0.38 * sin(vWorld.y * 120.0 - uTime * 5.0);
    float b = fract(vWorld.y * 0.32 - uTime * 0.28);
    float band = pow(max(0.0, 1.0 - abs(b - 0.5) * 2.0), 28.0);
    float flicker = 0.92 + 0.08 * sin(uTime * 41.0 + sin(uTime * 7.0) * 4.0);
    float a = (uFill + fres * 0.95 + band * 0.7) * lines * flicker;
    vec3 col = uColor * uIntensity * (0.35 + fres * 1.1 + band * 1.4);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uOpacity);
    #include <colorspace_fragment>
  }
`

export class HoloMaterial extends THREE.ShaderMaterial {
  private _op = 1
  constructor(opts: { color?: string; intensity?: number; rim?: number; fill?: number; opacity?: number } = {}) {
    super({
      uniforms: {
        uColor: { value: new THREE.Color(opts.color ?? HUE.info) },
        uTime: HOLO_TIME,
        uOpacity: { value: opts.opacity ?? 1 },
        uIntensity: { value: opts.intensity ?? 1 },
        uRim: { value: opts.rim ?? 2.2 },
        uFill: { value: opts.fill ?? 0.06 },
      },
      vertexShader: HOLO_VERT,
      fragmentShader: HOLO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.opacity = opts.opacity ?? 1
  }
  // Material asigna `this.opacity` en su constructor, antes de que existan
  // los uniforms: de ahí la guarda.
  get opacity() { return this._op }
  set opacity(v: number) {
    this._op = v
    if (this.uniforms?.uOpacity) this.uniforms.uOpacity.value = v
  }
  get intensity() { return this.uniforms.uIntensity.value as number }
  set intensity(v: number) { this.uniforms.uIntensity.value = v }
  setColor(c: THREE.ColorRepresentation) { (this.uniforms.uColor.value as THREE.Color).set(c) }
}

/** Material holográfico propio por instancia (el disolvido muta `.opacity`). */
export function useHoloMaterial(opts: ConstructorParameters<typeof HoloMaterial>[0] = {}) {
  const mat = useMemo(() => new HoloMaterial(opts), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => mat.dispose(), [mat])
  return mat
}

/* ── Textura de halo ───────────────────────────────────────────
   Degradado radial generado UNA vez en un canvas 2D y compartido. Sustituye
   al bloom: un sprite aditivo detrás de cada cosa que debe "brillar". */
let glowTex: THREE.Texture | null = null
export function getGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0.0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.18, 'rgba(255,255,255,0.55)')
  grd.addColorStop(0.45, 'rgba(255,255,255,0.14)')
  grd.addColorStop(1.0, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  glowTex = new THREE.CanvasTexture(c)
  glowTex.colorSpace = THREE.SRGBColorSpace
  return glowTex
}

/** Halo aditivo que siempre mira a la cámara. */
export function Glow({ color = HUE.info, scale = 1, opacity = 0.5, position }: {
  color?: string; scale?: number; opacity?: number; position?: [number, number, number]
}) {
  return (
    <sprite scale={scale} position={position} raycast={noRaycast}>
      <spriteMaterial
        map={getGlowTexture()} color={color} transparent opacity={opacity}
        blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false}
      />
    </sprite>
  )
}

/* ── Pedestal proyector ────────────────────────────────────────
   Anillos concéntricos, anillo punteado que gira, corona de ticks, barrido
   de radar y núcleo iluminado — todo en el fragment shader de UN quad. */
const PAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const PAD_FRAG = /* glsl */ `
  #define TAU 6.28318530718
  uniform vec3 uColor;
  uniform vec3 uDeep;
  uniform float uTime;
  uniform float uFocus;
  uniform float uSeed;
  varying vec2 vUv;
  float ring(float r, float R, float w) { return smoothstep(w, 0.0, abs(r - R)); }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);
    float t = uTime + uSeed;

    float c = ring(r, 0.97, 0.010) * 0.9
            + ring(r, 0.80, 0.005) * 0.5
            + ring(r, 0.46, 0.016) * 0.75
            + ring(r, 0.30, 0.004) * 0.45;

    float dash = step(0.45, fract((a + t * 0.5) / TAU * 40.0));
    c += ring(r, 0.885, 0.022) * dash * 0.75;

    float dash2 = step(0.7, fract((a - t * 0.9) / TAU * 12.0));
    c += ring(r, 0.62, 0.010) * dash2 * 0.8;

    float ticks = step(0.9, fract(a / TAU * 90.0)) * step(0.70, r) * step(r, 0.76);
    c += ticks * 0.55;

    float sw = fract((a - t * 1.3) / TAU);
    c += pow(sw, 14.0) * smoothstep(0.97, 0.2, r) * (0.25 + 0.55 * uFocus);

    c += smoothstep(0.45, 0.0, r) * (0.22 + 0.25 * uFocus);

    vec3 col = mix(uColor, uDeep, smoothstep(0.35, 1.0, r) * 0.55);
    float fade = smoothstep(1.0, 0.9, r);
    float alpha = c * fade * (0.35 + 0.65 * uFocus);
    gl_FragColor = vec4(col * 1.4, alpha);
    #include <colorspace_fragment>
  }
`

/* ── Haz del proyector ─────────────────────────────────────────
   Cono abierto que sube del pedestal: degradado vertical con estrías que
   giran. Muy tenue — tiene que sugerir la proyección, no tapar el holograma. */
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uFocus;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.8);
    float streak = 0.55 + 0.45 * sin(vUv.x * 6.28318 * 22.0 + uTime * 1.6);
    float a = fade * streak * (0.05 + 0.13 * uFocus);
    gl_FragColor = vec4(uColor * 1.3, a);
    #include <colorspace_fragment>
  }
`

const N_MOTES = 18

/**
 * Pedestal + haz + anillo de escaneo + partículas que suben. Todo depende del
 * `focusRef` (0 = de lado, 1 = de frente) que escribe RingHologram, así el
 * holograma del frente se "enciende" y los laterales quedan en reposo.
 */
export function HoloBase({ focusRef, activeRef, y = -1.45, radius = 1.35, seed = 0 }: {
  focusRef: { current: number }
  activeRef: { current: boolean }
  y?: number
  radius?: number
  seed?: number
}) {
  const scanRef = useRef<THREE.Mesh>(null)
  const motesRef = useRef<THREE.Points>(null)

  const padMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(HUE.info) },
      uDeep: { value: new THREE.Color(HUE.deep) },
      uTime: HOLO_TIME,
      uFocus: { value: 0 },
      uSeed: { value: seed * 1.7 },
    },
    vertexShader: PAD_VERT, fragmentShader: PAD_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, toneMapped: false,
  }), [seed])

  const beamMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(HUE.info) },
      uTime: HOLO_TIME,
      uFocus: { value: 0 },
    },
    vertexShader: PAD_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, toneMapped: false,
  }), [])

  // Partículas: posición inicial determinista (cada arranque igual).
  const motes = useMemo(() => {
    const pos = new Float32Array(N_MOTES * 3)
    const phase = new Float32Array(N_MOTES)
    for (let i = 0; i < N_MOTES; i++) phase[i] = ((i * 0.61803398875 + seed * 0.37) % 1)
    return { pos, phase }
  }, [seed])

  useEffect(() => () => { padMat.dispose(); beamMat.dispose() }, [padMat, beamMat])

  useFrame(state => {
    const f = focusRef.current
    const active = activeRef.current
    padMat.uniforms.uFocus.value = f
    beamMat.uniforms.uFocus.value = f * (active ? 1.25 : 1)
    const t = state.clock.elapsedTime + seed

    if (scanRef.current) {
      // Barrido vertical: sube del pedestal hasta la parte alta y reaparece.
      const k = (t * (active ? 0.55 : 0.32)) % 1
      scanRef.current.position.y = y + 0.05 + k * 2.7
      const s = radius * (1 - k * 0.3)
      scanRef.current.scale.set(s, s, 1)
      const m = scanRef.current.material as THREE.MeshBasicMaterial
      m.opacity = Math.sin(k * Math.PI) * (0.08 + 0.4 * f)
    }

    if (motesRef.current) {
      const arr = motes.pos
      for (let i = 0; i < N_MOTES; i++) {
        const k = (motes.phase[i] + t * 0.18) % 1
        const ang = i * 2.39996 + t * 0.25
        const rr = radius * (0.25 + 0.55 * ((i * 0.37) % 1)) * (1 - k * 0.35)
        arr[i * 3] = Math.cos(ang) * rr
        arr[i * 3 + 1] = y + k * 2.6
        arr[i * 3 + 2] = Math.sin(ang) * rr
      }
      const geo = motesRef.current.geometry
      ;(geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
      const m = motesRef.current.material as THREE.PointsMaterial
      m.opacity = 0.15 + 0.6 * f
      motesRef.current.visible = f > 0.15
    }
  })

  return (
    <group>
      <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} material={padMat} raycast={noRaycast}>
        <planeGeometry args={[radius * 2.3, radius * 2.3]} />
      </mesh>
      <mesh position={[0, y + 1.3, 0]} material={beamMat} raycast={noRaycast}>
        <cylinderGeometry args={[radius * 0.95, radius * 0.55, 2.6, 48, 1, true]} />
      </mesh>
      <mesh ref={scanRef} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <ringGeometry args={[0.96, 1.0, 96]} />
        <meshBasicMaterial color={HUE.info} transparent opacity={0.3}
          blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <points ref={motesRef} raycast={noRaycast}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[motes.pos, 3]} />
        </bufferGeometry>
        <pointsMaterial map={getGlowTexture()} color={HUE.info} size={0.09} transparent opacity={0.5}
          blending={THREE.AdditiveBlending} depthWrite={false} sizeAttenuation toneMapped={false} />
      </points>
    </group>
  )
}

/* ── Retícula HUD del activo ───────────────────────────────────
   Arcos que giran en sentidos opuestos + cuatro esquinas de encuadre. Mira
   siempre a la cámara (Billboard) y aparece con el foco: sólo el holograma
   seleccionado queda "fijado" por el visor. */
const BRACKET_PTS = (() => {
  const s = 1.85, l = 0.32
  const pts: number[] = []
  for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
    pts.push(sx * s, sy * s, 0, sx * (s - l), sy * s, 0)
    pts.push(sx * s, sy * s, 0, sx * s, sy * (s - l), 0)
  }
  return new Float32Array(pts)
})()

export function HoloReticle({ focusRef, activeRef }: {
  focusRef: { current: number }
  activeRef: { current: boolean }
}) {
  const groupRef = useRef<THREE.Group>(null)
  const a1 = useRef<THREE.Mesh>(null)
  const a2 = useRef<THREE.Mesh>(null)
  const a3 = useRef<THREE.Mesh>(null)
  const bracketRef = useRef<THREE.LineSegments>(null)
  const show = useRef(0)

  useFrame((_, delta) => {
    const target = activeRef.current ? focusRef.current : 0
    show.current += (target - show.current) * Math.min(1, delta * 6)
    const s = show.current
    if (groupRef.current) {
      groupRef.current.visible = s > 0.02
      // Entra "enfocando": llega desde más grande y se cierra sobre el objetivo.
      groupRef.current.scale.setScalar(1 + (1 - s) * 0.35)
    }
    if (a1.current) {
      a1.current.rotation.z += delta * 0.6
      ;(a1.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * s
    }
    if (a2.current) {
      a2.current.rotation.z -= delta * 0.9
      ;(a2.current.material as THREE.MeshBasicMaterial).opacity = 0.35 * s
    }
    if (a3.current) {
      a3.current.rotation.z += delta * 0.25
      ;(a3.current.material as THREE.MeshBasicMaterial).opacity = 0.7 * s
    }
    if (bracketRef.current) (bracketRef.current.material as THREE.LineBasicMaterial).opacity = 0.8 * s
  })

  const add = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false } as const

  return (
    <Billboard>
      <group ref={groupRef} visible={false}>
        <mesh ref={a1} raycast={noRaycast}>
          <ringGeometry args={[1.62, 1.66, 96, 1, 0, Math.PI * 0.6]} />
          <meshBasicMaterial color={HUE.info} opacity={0} {...add} />
        </mesh>
        <mesh ref={a2} rotation={[0, 0, Math.PI]} raycast={noRaycast}>
          <ringGeometry args={[1.72, 1.735, 96, 1, 0, Math.PI * 0.9]} />
          <meshBasicMaterial color={HUE.deep} opacity={0} {...add} />
        </mesh>
        <mesh ref={a3} raycast={noRaycast}>
          <ringGeometry args={[1.54, 1.585, 4, 1, 0, Math.PI * 0.08]} />
          <meshBasicMaterial color={HUE.info} opacity={0} {...add} />
        </mesh>
        <lineSegments ref={bracketRef} raycast={noRaycast}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[BRACKET_PTS, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={HUE.info} opacity={0} {...add} />
        </lineSegments>
      </group>
    </Billboard>
  )
}

/* ── Suelo de rejilla ──────────────────────────────────────────
   Plano grande bajo el anillo: rejilla polar (anillos + radios) que se
   desvanece con la distancia, y un pulso que se expande desde el centro.
   Da el "suelo de laboratorio" sin geometría: un quad y un shader. */
const FLOOR_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`
const FLOOR_FRAG = /* glsl */ `
  #define TAU 6.28318530718
  uniform vec3 uColor;
  uniform vec3 uDeep;
  uniform float uTime;
  varying vec3 vWorld;
  void main() {
    vec2 p = vWorld.xz;
    float r = length(p);
    float a = atan(p.y, p.x);
    // Líneas antialiasadas con fwidth: una por cada 2 unidades de radio y
    // 48 radios. Distancia a la línea más cercana, en píxeles de pantalla.
    float rr = r * 0.5;
    float rings = 1.0 - smoothstep(0.0, 1.5, abs(fract(rr - 0.5) - 0.5) / fwidth(rr));
    float sa = a / TAU * 48.0;
    float spokes = 1.0 - smoothstep(0.0, 1.2, abs(fract(sa - 0.5) - 0.5) / fwidth(sa));
    float pulse = pow(max(0.0, 1.0 - abs(r - mod(uTime * 3.0, 28.0)) * 0.9), 3.0);
    float fade = smoothstep(26.0, 6.0, r) * smoothstep(2.0, 5.0, r);
    float c = (rings * 0.55 + spokes * 0.25 + pulse * 0.6) * fade;
    vec3 col = mix(uDeep, uColor, 0.35 + pulse * 0.65);
    gl_FragColor = vec4(col, c * 0.5);
    #include <colorspace_fragment>
  }
`

export function HoloFloor({ y = -2.9 }: { y?: number }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(HUE.info) },
      uDeep: { value: new THREE.Color(HUE.deep) },
      uTime: HOLO_TIME,
    },
    vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }), [])
  useEffect(() => () => mat.dispose(), [mat])
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat} raycast={noRaycast}>
      <planeGeometry args={[60, 60]} />
    </mesh>
  )
}
