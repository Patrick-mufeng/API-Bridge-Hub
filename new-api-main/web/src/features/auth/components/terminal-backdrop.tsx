/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useEffect, useState } from 'react'

type TerminalBackdropProps = {
  className?: string
}

type LineKind = 'cmd' | 'ok' | 'out' | 'dim'

type ScriptLine = { kind: LineKind; text: string }

// The looping command-line story: what BridgeHub is, in its own words.
// It ends on an auth prompt - the glass card next to it is the answer.
const SCRIPT: ScriptLine[] = [
  { kind: 'dim', text: 'bridgehub v1.0.0 - personal AI API relay hub' },
  { kind: 'dim', text: '# one OpenAI-compatible endpoint for every model service' },
  { kind: 'cmd', text: '$ bridgehub status' },
  { kind: 'out', text: '  gateway ............ online' },
  { kind: 'ok', text: '  channels ........... 6 registered, 205 models' },
  { kind: 'out', text: '  region ............. local' },
  { kind: 'cmd', text: '$ bridgehub channels list' },
  { kind: 'out', text: '  workbuddy   wb:   pool ok    41 models' },
  { kind: 'out', text: '  qoder       qd:   pool ok    30 models' },
  { kind: 'out', text: '  cline       cl:   pool ok     4 models' },
  { kind: 'out', text: '  opencodez   ocz:  pool ok    13 models' },
  { kind: 'out', text: '  trae        tr:   pool ok    58 models' },
  { kind: 'out', text: '  cmdgo       cg:   pool ok    53 models' },
  { kind: 'cmd', text: '$ curl -s /v1/chat/completions \\' },
  { kind: 'out', text: '    -H "Authorization: Bearer sk-****" \\' },
  { kind: 'out', text: '    -d \'{"model":"wb:glm-5"}\'' },
  { kind: 'ok', text: '  200 OK - routed to workbuddy in 212ms (1,204 tokens)' },
  { kind: 'cmd', text: '$ bridgehub stats --tokens' },
  { kind: 'out', text: '  prompt 1.21M, completion 0.84M, TPM 88.4' },
  { kind: 'out', text: '  per-key quotas, per-model pricing, live dashboard' },
  { kind: 'dim', text: '# plug in a new service with a single manifest. no code.' },
  { kind: 'cmd', text: '$ bridgehub manifests reload' },
  { kind: 'ok', text: '  6 services loaded. hot-plug ready' },
  { kind: 'cmd', text: '$ bridgehub auth login' },
  { kind: 'ok', text: '  awaiting credentials ...' },
]

const TICK_MS = 26
const HOLD_TICKS = 170 // pause when the whole script is on screen
const TOTAL_CHARS = SCRIPT.reduce((sum, line) => sum + line.text.length + 1, 0)
const VISIBLE_LINES = 34

const LINE_COLOR: Record<LineKind, string> = {
  cmd: 'text-zinc-200',
  ok: 'text-emerald-400/90',
  out: 'text-zinc-500',
  dim: 'text-zinc-600',
}

/**
 * Full-bleed ambient terminal: an English command-line session that keeps
 * typing what BridgeHub does, forever. It IS the page background - the glass
 * auth card floats on top of it, and the session ends on an auth prompt that
 * the card answers.
 */
export function TerminalBackdrop({ className }: TerminalBackdropProps) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches
    if (reducedMotion) {
      setCount(TOTAL_CHARS)
      return
    }
    const iv = setInterval(() => {
      setCount((c) => (c + 1 > TOTAL_CHARS + HOLD_TICKS ? 0 : c + 1))
    }, TICK_MS)
    return () => clearInterval(iv)
  }, [])

  // Walk the script, cutting each line at the typing position.
  let remaining = count
  const rendered: Array<{ kind: LineKind; text: string; typing: boolean }> = []
  for (const line of SCRIPT) {
    if (remaining <= 0) break
    const take = Math.min(remaining, line.text.length)
    rendered.push({
      kind: line.kind,
      text: line.text.slice(0, take),
      typing: take < line.text.length,
    })
    remaining -= line.text.length + 1 // +1 for the newline
  }
  const allTyped = count > TOTAL_CHARS
  const visible = rendered.slice(-VISIBLE_LINES)

  return (
    <div
      aria-hidden
      className={`select-none overflow-hidden font-mono text-[13px] leading-7 ${className ?? ''}`}
    >
      <div className='flex flex-col'>
        {visible.map((line, i) => {
          const isLast = i === visible.length - 1
          const cursor = line.typing || (isLast && allTyped)
          return (
            <div key={i} className={LINE_COLOR[line.kind]}>
              {line.text}
              {cursor && (
                <span className='animate-pulse text-zinc-500'>▍</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
