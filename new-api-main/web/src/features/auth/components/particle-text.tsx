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

type ParticleTextProps = {
  text?: string
  className?: string
}

type Particle = {
  hx: number // home position (the glyph pixel it represents)
  hy: number
  x: number
  y: number
  vx: number
  vy: number
  size: number
  phase: number
}

const MOUSE_RADIUS = 120
const SPRING = 0.05
const DAMPING = 0.86

/**
 * The BridgeHub wordmark drawn as particles. Each particle owns one sampled
 * glyph pixel (its home); the pointer pushes particles apart and the spring
 * pulls them home again — scatter and regroup, forever.
 */
export function ParticleText({
  text = 'Bridge-Hub',
  className,
}: ParticleTextProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let particles: Particle[] = []
    let rafId = 0
    let disposed = false
    let lastW = 0
    let lastH = 0
    let lastTime = 0
    const mouse = { x: -99999, y: -99999 }
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches

    const buildParticles = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      lastW = w
      lastH = h

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Draw the wordmark offscreen and sample its pixels: one particle per
      // sampled pixel, home = that pixel's position.
      const fs = Math.min(w * 0.17, h * 0.72, 160)
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d', { willReadFrequently: true })
      if (!octx) return
      octx.fillStyle = '#fff'
      octx.font = `900 ${fs}px ui-sans-serif, system-ui, sans-serif`
      octx.textAlign = 'center'
      octx.textBaseline = 'middle'
      octx.fillText(text, w / 2, h / 2)

      const step = Math.max(3, Math.round(fs / 34))
      const data = octx.getImageData(0, 0, w, h).data
      particles = []
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          if (data[(y * w + x) * 4 + 3] > 128) {
            particles.push({
              hx: x,
              hy: y,
              x: w / 2 + (Math.random() - 0.5) * w * 0.6,
              y: h / 2 + (Math.random() - 0.5) * h * 0.6,
              vx: 0,
              vy: 0,
              size: 1.8 + Math.random() * 1.2,
              phase: Math.random() * Math.PI * 2,
            })
          }
        }
      }
    }

    const draw = (time: number) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w !== lastW || h !== lastH) {
        buildParticles()
      }
      const dt = Math.min(lastTime ? time - lastTime : 16, 64) / 1000
      lastTime = time
      const seconds = time / 1000

      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      for (const p of particles) {
        // pointer scatter: push particles away from the pointer
        const dx = p.x - mouse.x
        const dy = p.y - mouse.y
        const dist = Math.hypot(dx, dy)
        if (dist < MOUSE_RADIUS && dist > 0.01) {
          const force = Math.pow(1 - dist / MOUSE_RADIUS, 2) * 260 * dt
          p.vx += (dx / dist) * force
          p.vy += (dy / dist) * force
        }
        // spring home + damping: scatter -> regroup
        p.vx += (p.hx - p.x) * SPRING
        p.vy += (p.hy - p.y) * SPRING
        p.vx *= DAMPING
        p.vy *= DAMPING
        p.x += p.vx * (dt * 60)
        p.y += p.vy * (dt * 60)

        const jitterX = reducedMotion
          ? 0
          : Math.sin(seconds * 1.8 + p.phase) * 0.5
        const jitterY = reducedMotion
          ? 0
          : Math.cos(seconds * 1.6 + p.phase) * 0.5

        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(seconds * 2 + p.phase) ** 2
        ctx.fillStyle = '#5786FE'
        ctx.fillRect(
          p.x + jitterX - p.size / 2,
          p.y + jitterY - p.size / 2,
          p.size,
          p.size
        )
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
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

    buildParticles()

    if (reducedMotion) {
      // Static wordmark: particles drawn at home, no interaction loop.
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
      buildParticles()
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
  }, [text])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{
        pointerEvents: 'none',
        width: '100%',
        height: '100%',
        display: 'block',
      }}
    />
  )
}
