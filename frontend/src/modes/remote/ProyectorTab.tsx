import { S, T } from './theme'
import { nativeBridge } from './native'

/**
 * Ajuste de la proyección. El control es nativo (KeystoneActivity del APK) y
 * habla directo con el proyector por HTTP en la LAN: una página https no puede
 * hacerlo (contenido mixto), y así tampoco depende del PC.
 */
export function ProyectorTab({ onNotice }: { onNotice: (text: string) => void }) {
  const bridge = nativeBridge()

  const open = () => {
    if (!bridge?.openKeystone) {
      onNotice('Actualiza el APK de Jarvis para ajustar el proyector.')
      return
    }
    bridge.openKeystone()
  }

  return (
    <div>
      <div style={S.sectionTitle}>Proyector</div>
      <div style={S.card}>
        <div style={{ fontSize: 15, color: T.text, marginBottom: 8 }}>Ajustar la proyección</div>
        <div style={{ ...S.hint, marginBottom: 14 }}>
          Mueve las esquinas, el tamaño y la posición de toda la imagen: inicio, YouTube, Netflix y Monitor.
          Habla directo con el proyector, sin pasar por el PC.
        </div>
        <button style={S.btnAccent} onClick={open}>Abrir ajuste</button>
        {!bridge && <div style={{ ...S.hint, marginTop: 10 }}>Solo funciona dentro de la app de Jarvis en la tablet.</div>}
      </div>
    </div>
  )
}
