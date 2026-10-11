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
import { ParticleText } from './components/particle-text'
import { TerminalBackdrop } from './components/terminal-backdrop'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='relative grid h-svh max-w-none overflow-hidden bg-black'>
      {/* Ambient terminal: what BridgeHub does, typing forever, dimmed */}
      <TerminalBackdrop className='absolute inset-0 opacity-60' />

      <div className='relative z-10 flex h-full flex-col items-center'>
        {/* Particle wordmark — scatters around the pointer, then regroups */}
        <div className='mt-[9vh] h-[23vh] w-full max-w-5xl px-6'>
          <ParticleText text='Bridge-Hub' className='h-full w-full' />
        </div>

        {/* Glass sign-in card, sitting below the wordmark */}
        <div className='border-border/50 bg-card/60 mx-auto mt-10 flex w-full flex-col justify-center space-y-2 rounded-2xl border px-4 py-8 shadow-2xl shadow-black/60 backdrop-blur-xl sm:w-[460px] sm:p-8'>
          {children}
        </div>
      </div>
    </div>
  )
}
