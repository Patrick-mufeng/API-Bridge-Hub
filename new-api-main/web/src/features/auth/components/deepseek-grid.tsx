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
const CELL_PITCH = 16
const CELL_SIZE = 6
const MOUSE_RADIUS = 170

// DeepSeek brand blue for logo cells; neutral slate for the rest.
const LOGO_COLOR = '#5786FE'
const GRID_COLOR_LIGHT = '#64748b'
const GRID_COLOR_DARK = '#64748b'

type Cell = {
  x: number
  y: number
  isLogo: boolean
  // position inside the logo bounding box, for the idle shimmer wave
  wave: number
}

/**
 * Interactive grid backdrop: a canvas of small cells that collectively draw
 * the DeepSeek whale mark. Cells near the pointer light up; logo cells keep
 * a gentle idle shimmer so the whale stays readable without any interaction.
 */
export function DeepSeekGrid({ className }: DeepSeekGridProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cells: Cell[] = []
    let rafId = 0
    let disposed = false
    let lastW = 0
    let lastH = 0
    const mouse = { x: -99999, y: -99999 }
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches

    const isDark = () =>
      document.documentElement.classList.contains('dark')

    // Sample the DeepSeek path into the cell grid: one offscreen pixel per
    // cell, alpha > 127 means the cell belongs to the whale shape.
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

      const cols = Math.ceil(w / CELL_PITCH)
      const rows = Math.ceil(h / CELL_PITCH)

      const mask = document.createElement('canvas')
      mask.width = cols
      mask.height = rows
      const mctx = mask.getContext('2d', { willReadFrequently: true })
      if (!mctx) return

      // Fit the 24x24 mark into a centered box of ~42% viewport width.
      // On wide screens shift it left of the auth card so the whale stays
      // visible; on narrow screens center it behind the frosted card.
      const boxSize = Math.min(w * 0.42, h * 0.72, 640)
      const centerX = w >= 1024 ? w * 0.24 : w * 0.5
      const centerY = h * 0.5
      mctx.save()
      mctx.translate(
        centerX / CELL_PITCH - boxSize / CELL_PITCH / 2,
        centerY / CELL_PITCH - boxSize / CELL_PITCH / 2
      )
      mctx.scale((boxSize / 24) / CELL_PITCH, (boxSize / 24) / CELL_PITCH)
      mctx.fillStyle = '#fff'
      mctx.fill(new Path2D(DEEPSEEK_LOGO_PATH))
      mctx.restore()

      const data = mctx.getImageData(0, 0, cols, rows).data
      cells = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const alpha = data[(row * cols + col) * 4 + 3]
          const x = col * CELL_PITCH + CELL_PITCH / 2
          const y = row * CELL_PITCH + CELL_PITCH / 2
          cells.push({
            x,
            y,
            isLogo: alpha > 127,
            wave: (x + y) * 0.012,
          })
        }
      }
    }

    const smooth = (t: number) => t * t * (3 - 2 * t)

    const draw = (time: number) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // The auth layout settles after first paint (and in-app webviews start
      // small); rebuild the grid whenever the canvas box actually changed.
      if (w !== lastW || h !== lastH) {
        buildGrid()
      }
      ctx.clearRect(0, 0, w, h)
      const dark = isDark()
      const seconds = time / 1000
      const gridColor = dark ? GRID_COLOR_DARK : GRID_COLOR_LIGHT

      // Non-logo cells first (single style), then logo cells.
      ctx.fillStyle = gridColor
      for (const cell of cells) {
        if (cell.isLogo) continue
        const dx = cell.x - mouse.x
        const dy = cell.y - mouse.y
        const dist = Math.hypot(dx, dy)
        const boost =
          dist < MOUSE_RADIUS ? smooth(1 - dist / MOUSE_RADIUS) : 0
        const alpha = 0.12 + boost * 0.35
        if (alpha < 0.02) continue
        ctx.globalAlpha = alpha
        ctx.fillRect(
          cell.x - CELL_SIZE / 2,
          cell.y - CELL_SIZE / 2,
          CELL_SIZE,
          CELL_SIZE
        )
      }

      ctx.fillStyle = LOGO_COLOR
      for (const cell of cells) {
        if (!cell.isLogo) continue
        const dx = cell.x - mouse.x
        const dy = cell.y - mouse.y
        const dist = Math.hypot(dx, dy)
        const boost =
          dist < MOUSE_RADIUS ? smooth(1 - dist / MOUSE_RADIUS) : 0
        const shimmer = reducedMotion
          ? 0.1
          : 0.12 * Math.sin(seconds * 1.4 + cell.wave)
        const alpha = Math.min(1, 0.5 + shimmer + boost * 0.5)
        const size = CELL_SIZE + boost * 2.5
        ctx.globalAlpha = alpha
        ctx.fillRect(
          cell.x - size / 2,
          cell.y - size / 2,
          size,
          size
        )
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
      // Static backdrop: draw the whale once, no shimmer or pointer effects.
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
