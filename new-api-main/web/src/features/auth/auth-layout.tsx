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

/**
 * Split auth layout: the showcase pane (particle wordmark + live terminal)
 * owns the left side on wide screens; the glass sign-in card sits centered
 * in the right pane. Below `lg` it stacks — dim terminal backdrop behind a
 * wordmark and the card.
 */
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='relative h-svh max-w-none overflow-hidden bg-black'>
      {/* mobile-only dim terminal backdrop */}
      <TerminalBackdrop className='absolute inset-0 opacity-30 lg:hidden' />

      <div className='relative flex h-full flex-col items-center lg:flex-row lg:items-stretch'>
        {/* showcase pane */}
        <div className='flex w-full flex-col items-center justify-center px-6 pt-[9vh] lg:w-[55%] lg:items-start lg:border-r lg:border-white/5 lg:px-14 lg:pt-0 xl:px-20'>
          <div className='relative h-[15vh] w-full max-w-2xl lg:h-[20vh] lg:max-w-none'>
            <ParticleText text='Bridge-Hub' className='absolute inset-0' />
          </div>
          <TerminalBackdrop className='relative mt-12 hidden w-full max-w-xl lg:block' />
        </div>

        {/* card pane */}
        <div className='flex flex-1 items-start justify-center px-6 pt-2 lg:items-center lg:pt-0'>
          <div className='border-border/50 bg-card/60 mx-auto mt-6 flex w-full flex-col justify-center space-y-2 rounded-2xl border px-4 py-8 shadow-2xl shadow-black/60 backdrop-blur-xl sm:w-[420px] sm:p-8 lg:mt-0'>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
