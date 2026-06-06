import { useState } from 'react'

interface HudInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
}

export function HudInput({ value, onChange, onSubmit, placeholder = '' }: HudInputProps) {
  const [focused, setFocused] = useState(false)
  const [sweepKey, setSweepKey] = useState(0)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
    setSweepKey(k => k + 1)
  }

  return (
    <div className={`hud-input-wrap${focused ? ' hud-input-wrap--focused' : ''}`}>
      <input
        className="hud-input"
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => e.key === 'Enter' && onSubmit?.()}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="hud-input-line" />
      {(focused || value.length > 0) && (
        <div key={sweepKey} className="hud-input-sweep" />
      )}
    </div>
  )
}
