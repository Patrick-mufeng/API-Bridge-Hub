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
import { TerminalBackdrop } from './components/terminal-backdrop'

type AuthLayoutProps = {
  children: React.ReactNode
}

/**
 * Auth over a live terminal. The full-bleed typing session IS the page; the
 * glass card docks on the right (centered on small screens) and answers the
 * session's final line: "awaiting credentials ...".
 *
 * Web glassmorphism approximation (not Apple Liquid Glass): layered
 * translucent fill, 1px inner highlight, backdrop blur. Solid fallback for
 * prefers-reduced-transparency.
 */
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='relative min-h-[100dvh] overflow-hidden bg-zinc-950'>
      {/* the page IS the terminal */}
      <TerminalBackdrop className='absolute inset-0 px-6 py-8 opacity-80 sm:px-10 sm:py-10 lg:px-16 lg:py-12' />

      {/* vignette: keeps edges deep, guides the eye to the card */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_72%_50%,transparent_35%,rgba(0,0,0,0.6)_100%)]'
      />

      {/* glass auth card, docked right (centered on small screens) */}
      <div className='relative z-10 flex min-h-[100dvh] items-center justify-center px-6 sm:justify-end sm:px-12 lg:px-24'>
        <div className='w-full max-w-[400px] rounded-xl border border-white/10 bg-zinc-950/70 p-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_70px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-8 auth-card-in'>
          <div className='mb-7 font-mono text-xs text-zinc-500'>
            auth@bridgehub:~$ <span className='text-zinc-300'>login</span>
          </div>

          {children}

          <div className='mt-8 flex items-center gap-2 border-t border-white/5 pt-4 font-mono text-[11px] text-zinc-500'>
            <span className='relative flex size-1.5'>
              <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60' />
              <span className='relative inline-flex size-1.5 rounded-full bg-emerald-400' />
            </span>
            hub online · 6 channels
          </div>
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .auth-card-in { animation: auth-card-in 0.5s cubic-bezier(0.23, 1, 0.32, 1) both; }
          @keyframes auth-card-in {
            from { opacity: 0; transform: translateY(14px); }
            to { opacity: 1; transform: translateY(0); }
          }
        }
      `}</style>
    </div>
  )
}
