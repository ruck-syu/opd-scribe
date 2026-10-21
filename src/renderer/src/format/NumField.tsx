import { useEffect, useState, type ReactNode } from 'react'

/**
 * Numeric input that keeps what the doctor is typing (so "0." doesn't collapse to "0")
 * and commits every complete number immediately. Invalid text is discarded on blur.
 */
export function NumField(props: {
  label: string
  value: number
  onCommit: (n: number) => void
  width?: number | string
  step?: number
}): ReactNode {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])

  const commit = (next: string): void => {
    const trimmed = next.trim()
    const n = Number(trimmed)
    if (trimmed !== '' && Number.isFinite(n)) props.onCommit(n)
    else setText(String(props.value))
  }

  return (
    <label className="field" style={{ width: props.width }}>
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={props.step ?? 0.5}
        value={text}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          if (/^-?\d+(\.\d+)?$/.test(next.trim())) props.onCommit(Number(next))
        }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}
