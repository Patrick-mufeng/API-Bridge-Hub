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
import { Link } from '@tanstack/react-router'
import { ArrowRight, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

export function Hero() {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)

  return (
    <section className='relative z-10 overflow-hidden px-6 pt-24 pb-8 md:pt-32'>
      {/* Radial gradient background */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 opacity-25 dark:opacity-[0.12]'
        style={{
          background: [
            'radial-gradient(ellipse 60% 50% at 20% 20%, oklch(0.72 0.18 250 / 80%) 0%, transparent 70%)',
            'radial-gradient(ellipse 50% 40% at 80% 15%, oklch(0.65 0.15 200 / 60%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />
      {/* Grid pattern */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_30%,black_20%,transparent_100%)] bg-[size:4rem_4rem] opacity-[0.08]'
      />

      <div className='mx-auto flex max-w-4xl flex-col items-center text-center'>
        <div
          aria-hidden
          className='pointer-events-none absolute top-24 left-1/2 -z-10 h-48 w-[28rem] max-w-full -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-600/35 via-sky-500/25 to-cyan-400/35 blur-[90px]'
        />
        <div
          className='landing-animate-fade-up mb-5 inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-[11px] font-medium text-blue-600 opacity-0 shadow-xs dark:border-blue-400/20 dark:bg-blue-400/5 dark:text-blue-400'
          style={{ animationDelay: '0ms' }}
        >
          <span className='relative flex size-1.5'>
            <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75' />
            <span className='relative inline-flex size-1.5 rounded-full bg-blue-500 dark:bg-blue-400' />
          </span>
          {t('Personal AI relay for you and your friends.')}
        </div>

        <h1
          className='landing-animate-fade-up text-[clamp(2.5rem,6vw,4rem)] leading-[1.08] font-bold tracking-tight opacity-0'
          style={{ animationDelay: '60ms' }}
        >
          {t('One API,')}
          <br />
          <span className='bg-gradient-to-r from-blue-500 via-sky-500 to-cyan-400 bg-clip-text text-transparent'>
            {t('every model service.')}
          </span>
        </h1>

        <p
          className='landing-animate-fade-up text-muted-foreground/80 mt-5 max-w-2xl text-base leading-relaxed opacity-0 md:text-[15px]'
          style={{ animationDelay: '120ms' }}
        >
          {t(
            'BridgeHub aggregates multiple upstream channels behind one OpenAI-compatible endpoint. New services plug in as manifests, register as channels, and every model is reachable with a single key.'
          )}
        </p>

        <div
          className='landing-animate-fade-up mt-8 flex flex-wrap items-center justify-center gap-3 opacity-0'
          style={{ animationDelay: '180ms' }}
        >
          {isAuthenticated ? (
            <>
              <Button
                className='group h-11 rounded-lg px-5 text-sm font-medium'
                render={<Link to='/dashboard' />}
              >
                {t('Go to Dashboard')}
                <ArrowRight className='ml-1.5 size-4 transition-transform duration-200 group-hover:translate-x-0.5' />
              </Button>
              <Button
                variant='outline'
                className='group border-border/50 hover:border-border hover:bg-muted/50 h-11 rounded-lg px-5 text-sm font-medium'
                render={<Link to='/keys' />}
              >
                <KeyRound className='mr-1.5 size-4' />
                {t('API Keys')}
              </Button>
            </>
          ) : (
            <Button
              className='group h-11 rounded-lg px-6 text-sm font-medium'
              render={<Link to='/sign-in' />}
            >
              {t('Sign In')}
              <ArrowRight className='ml-1.5 size-4 transition-transform duration-200 group-hover:translate-x-0.5' />
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
