/** Lente gravitacional del fondo estelar.
 *
 *  Es lo que hace que la escena se LEA como un agujero negro y no como una
 *  esfera negra con un disco al lado: el campo de estrellas de detrás aparece
 *  deformado, con su anillo de Einstein, sus imágenes secundarias y una sombra
 *  de radio b = 3√3 M — dos coma seis veces el horizonte, que es el número que
 *  el ojo reconoce de las imágenes del EHT.
 *
 *  Nada de esto es un anillo pintado a mano. Cada píxel resuelve la MISMA
 *  geodésica nula que ya usan los rayos dibujados: se traza el rayo HACIA ATRÁS
 *  desde la cámara, se mira qué azimut barre hasta el infinito y se lee el
 *  cielo en esa dirección. La única concesión es de coste, no de física: la
 *  deflexión δ(b) —la integral cara— se precalcula UNA vez en CPU con el
 *  integrador ya verificado por los tests (`buildDeflectionLut`) y viaja al
 *  shader como una tabla de 512 muestras. El fragment shader hace una lectura,
 *  no una integración, así que el coste por píxel es constante.
 *
 *  Decisiones que esta máquina impone (ver CLAUDE.md):
 *   · UN SOLO contexto WebGL. Esto es un `mesh` más dentro del Canvas que ya
 *     existe: ni render targets, ni EffectComposer, ni OffscreenCanvas.
 *   · Cero asignaciones por frame: los uniformes se copian en objetos creados
 *     una vez.
 *   · La textura se carga a mano con `TextureLoader`, NUNCA con `useLoader`:
 *     aquí dentro no hay `Suspense` que sostenga la escena, y un fallo de red
 *     tiene que degradar a un fondo liso en vez de tumbar el visor.
 */

import { useRef, useMemo, useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { B_CRIT, buildDeflectionLut } from '../../lib/sim/schwarzschild'

/** Equirectangular de la Vía Láctea. MISMA ruta relativa que usa el fondo
 *  global del visor (`Model3DViewer`), a propósito: el navegador la sirve de
 *  caché y, sobre todo, el cielo lejos del agujero queda idéntico al de fuera
 *  de la lente. Nada de CDNs — esta máquina trabaja offline. */
const STARFIELD_URL = 'textures/2k_stars_milky_way.jpg'

/** Muestras de la tabla de deflexión. 512 bastan porque el eje es logarítmico
 *  en (b/b_crit − 1), donde δ es casi una recta: el error de interpolación
 *  medido contra el integrador es de 2.6e-5 rad, o sea 0.0015°. */
const LUT_SIZE = 512

/** Por debajo de esta distancia (en M) la cámara está tan encima del horizonte
 *  que la aproximación de observador lejano deja de tener sentido; se apaga la
 *  lente en vez de pintar algo inventado. */
const MIN_CAM_DISTANCE_M = 2.6

const vertexShader = /* glsl */`
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec3 vDir;

void main() {
  // El mismo truco que usa el shader de fondo de three: el cuadrilátero se
  // emite YA en coordenadas de dispositivo, pegado al plano lejano, así que
  // cubre la pantalla exactamente sea cual sea la transformación del grupo
  // padre. Des-proyectando la esquina se obtiene la dirección del rayo en
  // espacio de ojo, y la parte rotacional de la matriz de la cámara la lleva a
  // mundo. Interpolarla linealmente es EXACTO para una cámara perspectiva
  // (con una ortográfica w = 1 y esto daría una posición, no una dirección;
  // el visor usa perspectiva).
  vec4 eye = uInvProj * vec4(position.xy, 1.0, 1.0);
  vDir = mat3(uCamWorld) * (eye.xyz / eye.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const fragmentShader = /* glsl */`
precision highp float;

uniform sampler2D uSky;
uniform sampler2D uLut;
uniform vec3  uCamPos;
uniform vec3  uHole;
uniform float uWorldPerM;   // unidades de mundo que mide una M
uniform float uLogMin;
uniform float uLogSpan;
uniform float uLutSize;
uniform float uBCrit;
uniform float uHasSky;

varying vec3 vDir;

const float PI = 3.141592653589793;

/** Espejo EXACTO de lutDeflection() en schwarzschild.ts. Si uno cambia, el
 *  otro también: los tests de Node validan el de allí, y este es el que se ve.
 *  Muestreo NEAREST + mezcla a mano a propósito — el filtrado lineal de
 *  texturas float no es universal, y dos lecturas no cuestan nada. */
float lutDelta(float b) {
  float eps = max(b / uBCrit - 1.0, 1e-20);
  float x = clamp((log(eps) - uLogMin) / uLogSpan, 0.0, 1.0) * (uLutSize - 1.0);
  float i0 = min(floor(x), uLutSize - 2.0);
  float f = x - i0;
  float a = texture2D(uLut, vec2((i0 + 0.5) / uLutSize, 0.5)).r;
  float c = texture2D(uLut, vec2((i0 + 1.5) / uLutSize, 0.5)).r;
  return mix(a, c, f);
}

/** Copia literal de equirectUv() de three, para que el cielo lensado y el
 *  fondo global de la escena casen píxel a píxel donde la lente no dobla nada. */
vec2 equirectUv(vec3 dir) {
  return vec2(atan(dir.z, dir.x) * (0.5 / PI) + 0.5,
              asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 toCam = uCamPos - uHole;
  float dist = length(toCam);
  float DM = dist / max(uWorldPerM, 1e-9);   // distancia de la cámara, en M
  vec3 n = toCam / max(dist, 1e-9);          // agujero → cámara

  vec3 sky = d;
  float lit = 1.0;

  if (DM > ${MIN_CAM_DISTANCE_M.toFixed(1)}) {
    float cosChi = clamp(dot(d, n), -1.0, 1.0);
    float chi = acos(cosChi);
    // sin ψ = (b/r)√(1 − 2M/r): relación EXACTA entre el ángulo que mide un
    // observador estático y el parámetro de impacto. Es la que fija el tamaño
    // angular de la sombra.
    float b = DM * sin(chi) / sqrt(1.0 - 2.0 / DM);

    // Sólo un rayo que apunta HACIA el agujero puede caer en él: sin ψ vale lo
    // mismo a los dos lados de 90°, y sin esta condición el punto del cielo
    // OPUESTO al agujero saldría negro.
    if (cosChi < 0.0 && b <= uBCrit) {
      lit = 0.0;                              // sombra: ningún fotón llega
    } else {
      float delta = lutDelta(b);
      // Cola de deflexión pendiente entre la cámara y el infinito. Interpola
      // entre el campo débil (2M/b) y δ/2, que es su valor exacto cuando la
      // cámara está en el periastro — así las dos ramas empalman sin costura.
      float c = min(abs(cosChi), 1.0);
      float k = c * (2.0 / max(b, 1e-9)) + (1.0 - c) * delta * 0.5;
      float tail = (1.0 - c) * k;
      float dphi = chi + (cosChi >= 0.0 ? tail : max(0.0, delta - tail));

      vec3 perp = d - cosChi * n;
      float lp = length(perp);
      vec3 t = lp > 1e-6 ? perp / lp : vec3(0.0);
      sky = cos(dphi) * n + sin(dphi) * t;
    }
  }

  // Sin textura no hay cielo que doblar: queda el negro del espacio, y la
  // sombra sigue siendo visible porque el resto de la escena se pinta encima.
  vec3 col = uHasSky > 0.5 ? texture2D(uSky, equirectUv(sky)).rgb : vec3(0.0);
  gl_FragColor = vec4(col * lit, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export interface BlackHoleLensProps {
  /** Masa en unidades geométricas. */
  mass: number
  /** Unidades locales de la escena por cada M (el `viewScale` de la vista). */
  viewScale: number
}

/**
 * Se monta como hijo del grupo de `BlackHoleView`, sin transformación propia:
 * su `matrixWorld` ES la del grupo, y de ahí salen el centro del agujero y la
 * escala mundo↔M sin tener que pasar refs desde el padre.
 */
export function BlackHoleLens({ mass, viewScale }: BlackHoleLensProps) {
  const mesh = useRef<THREE.Mesh>(null)
  const camera = useThree((s) => s.camera)
  const [sky, setSky] = useState<THREE.Texture | null>(null)

  // La tabla se construye una vez por masa (~18 ms medidos). No depende de la
  // cámara: δ(b) es una propiedad de la métrica, no del punto de vista.
  const lut = useMemo(() => buildDeflectionLut(LUT_SIZE, mass > 0 ? mass : 1), [mass])

  const lutTex = useMemo(() => {
    const t = new THREE.DataTexture(
      lut.data, lut.size, 1, THREE.RedFormat, THREE.FloatType,
    )
    // NEAREST + mezcla a mano en el shader: el filtrado lineal de texturas
    // float depende de una extensión que no está garantizada.
    t.minFilter = THREE.NearestFilter
    t.magFilter = THREE.NearestFilter
    t.wrapS = THREE.ClampToEdgeWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.needsUpdate = true
    return t
  }, [lut])

  useEffect(() => {
    let cancelled = false
    const loader = new THREE.TextureLoader()
    loader.load(
      STARFIELD_URL,
      (t) => {
        if (cancelled) { t.dispose(); return }
        // Es una FOTO: sin marcarla sRGB el renderer la trata como lineal y la
        // Vía Láctea sale lavada (misma nota que el fondo global del visor).
        t.colorSpace = THREE.SRGBColorSpace
        // El azimut da la vuelta entera, la declinación no.
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.ClampToEdgeWrapping
        // Los mipmaps NO son decoración: justo fuera de la sombra el barrido Δφ
        // diverge y píxeles vecinos leen puntos del cielo muy separados. La
        // selección automática de nivel promedia ahí, y ese promedio es lo que
        // hace aparecer el anillo de fotones como una línea brillante en vez de
        // como ruido centelleante.
        t.generateMipmaps = true
        t.minFilter = THREE.LinearMipmapLinearFilter
        t.magFilter = THREE.LinearFilter
        t.anisotropy = 4
        t.needsUpdate = true
        setSky(t)
      },
      undefined,
      () => { /* sin estrellas: fondo negro y sombra igual de visible */ },
    )
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => { sky?.dispose() }, [sky])
  useEffect(() => () => { lutTex.dispose() }, [lutTex])

  const uniforms = useMemo(() => ({
    uSky: { value: null as THREE.Texture | null },
    uLut: { value: lutTex },
    uCamPos: { value: new THREE.Vector3() },
    uHole: { value: new THREE.Vector3() },
    uWorldPerM: { value: 1 },
    uLogMin: { value: lut.logMin },
    uLogSpan: { value: Math.max(1e-9, lut.logMax - lut.logMin) },
    uLutSize: { value: lut.size },
    uBCrit: { value: B_CRIT },
    uHasSky: { value: 0 },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
  }), [lut, lutTex])

  useEffect(() => {
    uniforms.uSky.value = sky
    uniforms.uHasSky.value = sky ? 1 : 0
  }, [sky, uniforms])

  const scratch = useMemo(() => ({ scale: new THREE.Vector3() }), [])

  useFrame(() => {
    const m = mesh.current
    if (!m) return
    // R3F ejecuta los useFrame ANTES de que three actualice el grafo, así que
    // sin esto el centro del agujero llevaría un frame de retraso.
    m.updateWorldMatrix(true, false)
    uniforms.uHole.value.setFromMatrixPosition(m.matrixWorld)
    scratch.scale.setFromMatrixScale(m.matrixWorld)
    // El grupo padre puede llevar su propia escala (`spec.scale` del visor),
    // así que una M no mide `viewScale` unidades de MUNDO sino eso por la
    // escala acumulada.
    uniforms.uWorldPerM.value = Math.max(1e-9, mass * viewScale * scratch.scale.x)
    // Igual que arriba, pero aquí IMPORTA de verdad: three refresca la matriz
    // de la cámara dentro de gl.render, o sea DESPUÉS de este callback. Sin
    // esto el fondo iría un frame por detrás de la escena y NADARÍA al orbitar.
    // Los controles corren en prioridad -1, así que a esta altura ya la movieron.
    camera.updateMatrixWorld()
    uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    uniforms.uInvProj.value.copy(camera.projectionMatrixInverse)
    uniforms.uCamWorld.value.copy(camera.matrixWorld)
  })

  return (
    <mesh ref={mesh} frustumCulled={false} renderOrder={-1000}>
      {/* El cuadrilátero se re-proyecta entero en el vertex shader; su
          geometría sólo aporta las cuatro esquinas. */}
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        depthTest={false}
        depthWrite={false}
        transparent={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
