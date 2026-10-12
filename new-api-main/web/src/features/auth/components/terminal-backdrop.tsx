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
import { useEffect, useRef, useState } from 'react'

type TerminalBackdropProps = {
  className?: string
}

type LineKind = 'cmd' | 'ok' | 'out' | 'dim'

type ScriptLine = { kind: LineKind; text: string }

// Three looping scenes of the CLI story. Together they answer: what is this,
// what runs on it, what does a request look like, what does it cost, how do
// services plug in, and how do you sign in. The buffer scrolls like a real
// terminal - nothing ever clears.
const SCENES: ScriptLine[][] = [
  [
    { kind: 'dim', text: 'bridgehub v1.0.0 - personal AI API relay hub' },
    { kind: 'dim', text: '# one OpenAI-compatible endpoint for every model service' },
    { kind: 'cmd', text: '$ bridgehub status' },
    { kind: 'out', text: '[06:12:44]   gateway ............ online' },
    { kind: 'ok', text: '[06:12:44]   channels ...... 6 registered, 205 models' },
    { kind: 'out', text: '[06:12:44]   region ............ local' },
    { kind: 'cmd', text: '$ bridgehub channels list' },
    { kind: 'out', text: '[06:12:51]   workbuddy   wb:   pool ok    41 models' },
    { kind: 'out', text: '[06:12:51]   qoder       qd:   pool ok    30 models' },
    { kind: 'out', text: '[06:12:51]   cline       cl:   pool ok     4 models' },
    { kind: 'out', text: '[06:12:52]   opencodez   ocz:  pool ok    13 models' },
    { kind: 'out', text: '[06:12:52]   trae        tr:   pool ok    58 models' },
    { kind: 'out', text: '[06:12:52]   cmdgo       cg:   pool ok    53 models' },
    { kind: 'cmd', text: '$ curl -s /v1/chat/completions \\' },
    { kind: 'out', text: '    -H "Authorization: Bearer sk-****" \\' },
    { kind: 'out', text: '    -d \'{"model":"wb:glm-5"}\'' },
    { kind: 'ok', text: '[06:13:02]   200 OK - routed to workbuddy in 212ms, 1204 tokens' },
  ],
  [
    { kind: 'cmd', text: '$ bridgehub stats --tokens' },
    { kind: 'out', text: '[06:13:09]   prompt 1.21M, completion 0.84M, TPM 88.4' },
    { kind: 'out', text: '[06:13:09]   per-key quotas, per-model pricing, live dashboard' },
    { kind: 'cmd', text: '$ tail -f logs/relay.log' },
    { kind: 'out', text: '[06:14:02]   ocz:glm-5-turbo  200  387ms  962 tokens' },
    { kind: 'out', text: '[06:14:05]   tr:glm-4-flash   200  121ms  301 tokens' },
    { kind: 'out', text: '[06:14:11]   wb:cn-auto       200  1.1s   18,540 tokens' },
    { kind: 'out', text: '[06:14:19]   cg:m2.5          200  2.4s   4,022 tokens' },
    { kind: 'dim', text: '# plug in a new service with a single manifest. no code.' },
    { kind: 'cmd', text: '$ bridgehub manifests reload' },
    { kind: 'ok', text: '[06:14:30]   6 services loaded. hot-plug ready' },
  ],
  [
    { kind: 'cmd', text: '$ bridgehub auth login' },
    { kind: 'ok', text: '[06:15:01]   session opened - credentials accepted' },
    { kind: 'cmd', text: '$ bridgehub keys rotate --user patrick' },
    { kind: 'ok', text: '[06:15:10]   key rotated. old key valid for 24h' },
    { kind: 'dim', text: '# rate limits, quotas and pricing stay per channel' },
    { kind: 'cmd', text: '$ bridgehub doctor' },
    { kind: 'out', text: '[06:15:22]   sqlite ......... ok' },
    { kind: 'out', text: '[06:15:22]   relay pool ..... ok' },
    { kind: 'out', text: '[06:15:22]   panel proxy .... ok' },
    { kind: 'ok', text: '[06:15:22]   all systems nominal' },
    { kind: 'cmd', text: '$ bridgehub auth login' },
    { kind: 'ok', text: '  awaiting credentials ...' },
  ],
]

const LINES: ScriptLine[] = SCENES.flat()

const TICK_MS = 26
const TOTAL_CHARS = SCENES.flat().reduce(
  (sum, line) => sum + line.text.length + 1,
  0
)
const VISIBLE_LINES = 44

const LINE_COLOR: Record<LineKind, string> = {
  cmd: 'text-zinc-200',
  ok: 'text-emerald-400/90',
  out: 'text-zinc-500',
  dim: 'text-zinc-600',
}

/**
 * Full-bleed ambient terminal: an English command-line session that keeps
 * typing what BridgeHub does, forever, in a scrolling buffer that never
 * clears. It IS the page background - the glass auth card floats on top and
 * the session's final line ("awaiting credentials ...") is what the card
 * answers.
 */
export function TerminalBackdrop({ className }: TerminalBackdropProps) {
  const [lines, setLines] = useState<ScriptLine[]>(() => [{ kind: LINES[0].kind, text: '' }])
  const posRef = useRef({ line: 0, char: 0 })

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches
    if (reducedMotion) {
      // Full history, statically rendered.
      const full: ScriptLine[] = []
      for (const scene of SCENES) full.push(...scene)
      setLines(full)
      return
    }
    const iv = setInterval(() => {
      setLines((prev) => {
        const next = [...prev]
        const current = { ...next[next.length - 1] }
        const line = LINES[posRef.current.line]
        posRef.current.char += 1

        if (posRef.current.char > line.text.length) {
          // commit the finished line, open the next one (the list loops)
          posRef.current.line = (posRef.current.line + 1) % LINES.length
          posRef.current.char = 0
          const upcoming = LINES[posRef.current.line]
          next.push({ kind: upcoming.kind, text: '' })
        } else {
          current.text = line.text.slice(0, posRef.current.char)
          next[next.length - 1] = current
        }

        // rolling buffer: history scrolls out the top, screen never clears
        return next.length > VISIBLE_LINES + 6
          ? next.slice(-(VISIBLE_LINES + 4))
          : next
      })
    }, TICK_MS)
    return () => clearInterval(iv)
  }, [])

  const visible = lines.slice(-VISIBLE_LINES)

  return (
    <div
      aria-hidden
      className={`select-none overflow-hidden font-mono ${className ?? ''}`}
      style={{
        // scale the session with the viewport so it fills big screens
        fontSize: 'clamp(13px, 1vw + 4px, 22px)',
        lineHeight: 1.85,
      }}
    >
      <div className='flex flex-col justify-start min-h-full'>
        {visible.map((line, i) => {
          const isLast = i === visible.length - 1
          return (
            <div key={i} className={LINE_COLOR[line.kind]}>
              {line.text}
              {isLast && (
                <span className='animate-pulse text-zinc-500'>▍</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
