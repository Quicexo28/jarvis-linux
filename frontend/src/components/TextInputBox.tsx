import { useEffect, useRef, useState } from 'react'
import { useJarvisStore } from '../state/jarvisStore'

interface TextInputBoxProps {
  onSubmit: (text: string) => void
  onClose: () => void
}

// Cuadro para escribirle a Jarvis. Lo escrito entra por el mismo camino que la
// voz (AwakeApp.handleSttFinal) y se ve como el último turno de la conversación.
export function TextInputBox({ onSubmit, onClose }: TextInputBoxProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const coreInput = useJarvisStore(s => s.coreInput)
  const coreReply = useJarvisStore(s => s.coreReply)

  useEffect(() => { inputRef.current?.focus() }, [])

  const send = () => {
    const text = value.trim()
    if (!text) return
    onSubmit(text)
    setValue('')
  }

  return (
    <div className="text-input-box" onKeyDown={e => e.stopPropagation()}>
      {(coreInput || coreReply) && (
        <div className="text-input-log">
          {coreInput && <div className="text-input-line text-input-line--user">Usted: {coreInput}</div>}
          {coreReply && <div className="text-input-line">Jarvis: {coreReply}</div>}
        </div>
      )}
      <div className="text-input-row">
        <input
          ref={inputRef}
          className="hud-input text-input-field"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') send()
            else if (e.key === 'Escape') onClose()
          }}
          placeholder="Escriba una indicación para Jarvis…"
          spellCheck={false}
          autoComplete="off"
        />
        <button className="text-input-btn" onClick={send} disabled={!value.trim()}>Enviar</button>
        <button className="text-input-btn" onClick={onClose} title="Cerrar (Esc)">✕</button>
      </div>
    </div>
  )
}
