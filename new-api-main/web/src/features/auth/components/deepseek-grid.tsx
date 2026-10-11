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
import { useEffect, useRef } from 'react'

import { DEEPSEEK_LOGO_PATH } from './deepseek-logo-path'

type DeepSeekGridProps = {
  className?: string
}

// Grid geometry, in CSS pixels.
const CELL_PITCH = 18
const CELL_SIZE = 8
const MOUSE_RADIUS = 190

// The whale swims right -> left, then re-enters from the right edge.
const CROSSING_MS = 34000
// Tail-beat: about one full sweep per second, wave running head -> tail.
const TAIL_BEAT_HZ = 0.9

// DeepSeek brand blue for whale cells; neutral slate for the rest.
const LOGO_COLOR = '#5786FE'
const GRID_COLOR = '#64748b'
const BUBBLE_COLOR = '#7dd3fc'

type Cell = { x: number; y: number }

type WhaleCell = { lx: number; ly: number }

type Bubble = {
  x: number
  y: number
  r: number
  vy: number // px/s, negative = rising
  wobbleAmp: number
  wobbleFreq: number
  phase: number
  alpha: number
}

type Plankton = {
  x: number
  y: number
  r: number
  vx: number // px/s, negative = drifting left with the current
  alpha: number
}

/**
 * Interactive ocean backdrop: a grid of cells the DeepSeek whale swims
 * through, right to left, with a carangiform body wave — head barely moves,
 * amplitude grows toward the tail so the tail fin visibly sweeps. Cells near
 * the pointer light up; the whale leaves a bubble trail, ambient bubbles
 * rise, plankton drifts with the current. `prefers-reduced-motion` renders
 * a static centered whale.
 */
export function DeepSeekGrid({ className }: DeepSeekGridProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let disposed = false
    let rafId = 0
    let lastW = 0
    let lastH = 0
    let lastTime = 0
    const mouse = { x: -99999, y: -99999 }
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches

    let cells: Cell[] = []

    // Whale pattern in its own local grid space, sampled once per resize.
    // Head sits at lx = 0 (the mark faces left, matching the swim direction);
    // the tail is the high-lx end, where the body wave amplitude peaks.
    let whaleCells: WhaleCell[] = []
    let whaleAmp: Float32Array = new Float32Array(0)
    let whaleCols = 0
    let whaleRows = 0
    let whaleBox = 0
    let maxSway = 0

    let bubbles: Bubble[] = []
    let plankton: Plankton[] = []

    const isDark = () =>
      document.documentElement.classList.contains('dark')

    const buildGrid = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      lastW = w
      lastH = h

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      cells = []
      for (let y = CELL_PITCH / 2; y < h; y += CELL_PITCH) {
        for (let x = CELL_PITCH / 2; x < w; x += CELL_PITCH) {
          cells.push({ x, y })
        }
      }

      // Sample the whale mark into its OWN local grid (one pixel per cell),
      // centered in a box of ~44% viewport width.
      whaleBox = Math.min(w * 0.44, h * 0.68, 640)
      whaleCols = Math.ceil(whaleBox / CELL_PITCH) + 1
      whaleRows = Math.ceil(whaleBox / CELL_PITCH) + 1
      const mask = document.createElement('canvas')
      mask.width = whaleCols
      mask.height = whaleRows
      const mctx = mask.getContext('2d', { willReadFrequently: true })
      if (!mctx) return
      mctx.save()
      mctx.translate(
        whaleCols / 2 - whaleBox / CELL_PITCH / 2,
        whaleRows / 2 - whaleBox / CELL_PITCH / 2
      )
      mctx.scale(whaleBox / 24 / CELL_PITCH, whaleBox / 24 / CELL_PITCH)
      mctx.fillStyle = '#fff'
      mctx.fill(new Path2D(DEEPSEEK_LOGO_PATH))
      mctx.restore()
      const data = mctx.getImageData(0, 0, whaleCols, whaleRows).data

      whaleCells = []
      for (let row = 0; row < whaleRows; row++) {
        for (let col = 0; col < whaleCols; col++) {
          if (data[(row * whaleCols + col) * 4 + 3] > 127) {
            whaleCells.push({ lx: col, ly: row })
          }
        }
      }

      // Carangiform amplitude profile: ~0 at the head, peaking at the tail.
      maxSway = whaleBox * 0.055
      whaleAmp = new Float32Array(whaleCols)
      for (let col = 0; col < whaleCols; col++) {
        const t = (col + 0.5) / whaleCols
        whaleAmp[col] = maxSway * Math.pow(t, 1.6)
      }

      // Seed plankton across the viewport.
      plankton = Array.from({ length: 26 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.8 + Math.random() * 1,
        vx: -(4 + Math.random() * 10),
        alpha: 0.06 + Math.random() * 0.14,
      }))
      bubbles = []
    }

    const spawnAmbientBubble = (w: number, h: number) => {
      bubbles.push({
        x: Math.random() * w,
        y: h + 8,
        r: 1.5 + Math.random() * 3,
        vy: -(10 + Math.random() * 18),
        wobbleAmp: 3 + Math.random() * 6,
        wobbleFreq: 0.4 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.12 + Math.random() * 0.14,
      })
    }

    const smooth = (t: number) => t * t * (3 - 2 * t)

    // Horizontal sway of a body column at time `seconds` — a wave that
    // travels head -> tail with amplitude picked by whaleAmp[col].
    const sway = (col: number, seconds: number) =>
      whaleAmp[col] *
      Math.sin(
        seconds * TAIL_BEAT_HZ * Math.PI * 2 - (col / whaleCols) * 2.4
      )

    const draw = (time: number) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w !== lastW || h !== lastH) {
        buildGrid()
      }
      const dt = Math.min(lastTime ? time - lastTime : 16, 64) / 1000
      lastTime = time
      const seconds = time / 1000
      const dark = isDark()

      ctx.clearRect(0, 0, w, h)

      // Whale position: linear drift right -> left (constant motion), with a
      // slow vertical bob. Off-screen left wraps back to the right edge.
      const span = w + whaleBox * 2
      const whaleX =
        w + whaleBox - ((time % CROSSING_MS) / CROSSING_MS) * span
      const whaleY =
        h * 0.52 + Math.sin(time * 0.00045 * Math.PI * 2) * h * 0.035
      const originX = whaleX - whaleBox / 2
      const originY = whaleY - whaleBox / 2
      const whaleVisible =
        whaleX + whaleBox / 2 > 0 && whaleX - whaleBox / 2 < w

      // --- bubbles: whale trail + ambient risers -------------------------
      if (!reducedMotion) {
        const tailX = originX + whaleBox * 0.92 + sway(whaleCols - 2, seconds)
        if (whaleVisible && Math.random() < 0.12 && bubbles.length < 60) {
          bubbles.push({
            x: tailX,
            y: originY + whaleBox * (0.3 + Math.random() * 0.35),
            r: 1.2 + Math.random() * 2.6,
            vy: -(14 + Math.random() * 22),
            wobbleAmp: 2 + Math.random() * 5,
            wobbleFreq: 0.5 + Math.random() * 0.9,
            phase: Math.random() * Math.PI * 2,
            alpha: 0.18 + Math.random() * 0.2,
          })
        }
        if (
          Math.random() < 0.02 &&
          bubbles.filter((b) => b.y > h * 0.4).length < 18
        ) {
          spawnAmbientBubble(w, h)
        }
      }

      // --- plankton: tiny dots drifting with the current ------------------
      ctx.fillStyle = dark ? '#94a3b8' : '#64748b'
      for (const p of plankton) {
        if (!reducedMotion) {
          p.x += p.vx * dt
          if (p.x < -4) {
            p.x = w + 4
            p.y = Math.random() * h
          }
        }
        ctx.globalAlpha = p.alpha
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }

      // --- grid cells -----------------------------------------------------
      ctx.fillStyle = GRID_COLOR
      for (const cell of cells) {
        const dx = cell.x - mouse.x
        const dy = cell.y - mouse.y
        const dist = Math.hypot(dx, dy)
        const boost =
          dist < MOUSE_RADIUS ? smooth(1 - dist / MOUSE_RADIUS) : 0
        const alpha = (dark ? 0.14 : 0.12) + boost * 0.4
        ctx.globalAlpha = alpha
        ctx.fillRect(
          cell.x - CELL_SIZE / 2,
          cell.y - CELL_SIZE / 2,
          CELL_SIZE,
          CELL_SIZE
        )
      }

      // --- whale cells: painted at their swayed, sub-pixel positions ------
      ctx.fillStyle = LOGO_COLOR
      for (const wc of whaleCells) {
        const worldX =
          originX +
          wc.lx * CELL_PITCH +
          CELL_PITCH / 2 +
          (reducedMotion ? 0 : sway(wc.lx, seconds))
        const worldY = originY + wc.ly * CELL_PITCH + CELL_PITCH / 2
        const dx = worldX - mouse.x
        const dy = worldY - mouse.y
        const dist = Math.hypot(dx, dy)
        const boost =
          dist < MOUSE_RADIUS ? smooth(1 - dist / MOUSE_RADIUS) : 0
        const alpha = Math.min(1, 0.55 + boost * 0.45)
        const size = CELL_SIZE + boost * 3
        ctx.globalAlpha = alpha
        ctx.fillRect(
          worldX - size / 2,
          worldY - size / 2,
          size,
          size
        )
      }
      ctx.globalAlpha = 1

      // --- bubbles on top ---------------------------------------------------
      ctx.fillStyle = BUBBLE_COLOR
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i]
        if (!reducedMotion) {
          b.y += b.vy * dt
          b.x += Math.sin(seconds * b.wobbleFreq * Math.PI * 2 + b.phase) * b.wobbleAmp * dt
        }
        if (b.y < -10) {
          bubbles.splice(i, 1)
          continue
        }
        const dx = b.x - mouse.x
        const dy = b.y - mouse.y
        const dist = Math.hypot(dx, dy)
        const boost =
          dist < MOUSE_RADIUS ? smooth(1 - dist / MOUSE_RADIUS) : 0
        ctx.globalAlpha = Math.min(0.8, b.alpha + boost * 0.45)
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const loop = (time: number) => {
      if (disposed) return
      draw(time)
      rafId = requestAnimationFrame(loop)
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      mouse.x = event.clientX - rect.left
      mouse.y = event.clientY - rect.top
    }
    const onPointerLeave = () => {
      mouse.x = -99999
      mouse.y = -99999
    }

    buildGrid()

    if (reducedMotion) {
      // Static composition: whale centered, a few bubbles, no motion.
      draw(0)
    } else {
      rafId = requestAnimationFrame(loop)
      window.addEventListener('pointermove', onPointerMove, {
        passive: true,
      })
      document.documentElement.addEventListener(
        'pointerleave',
        onPointerLeave
      )
    }

    const onResize = () => {
      buildGrid()
      if (reducedMotion) draw(0)
    }
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      if (!reducedMotion) {
        window.removeEventListener('pointermove', onPointerMove)
        document.documentElement.removeEventListener(
          'pointerleave',
          onPointerLeave
        )
      }
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{
        pointerEvents: 'none',
        // never rely on utility classes for the canvas box: the default
        // 300x150 attribute size would silently shrink the whole backdrop
        width: '100%',
        height: '100%',
        display: 'block',
      }}
    />
  )
}
