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
import { useTranslation } from 'react-i18next'

import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

import { DeepSeekGrid } from './components/deepseek-grid'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()

  return (
    <div className='relative grid h-svh max-w-none overflow-hidden bg-black'>
      {/* Interactive DeepSeek grid backdrop */}
      <DeepSeekGrid className='absolute inset-0' />

      <Link
        to='/'
        className='absolute top-4 left-4 z-10 flex items-center gap-2 transition-opacity hover:opacity-80 sm:top-8 sm:left-8'
      >
        <div className='relative h-8 w-8'>
          {loading ? (
            <Skeleton className='absolute inset-0 rounded-full' />
          ) : (
            <img
              src={logo}
              alt={t('Logo')}
              className='bg-card/60 h-8 w-8 rounded-full object-cover backdrop-blur-sm'
            />
          )}
        </div>
        {loading ? (
          <Skeleton className='h-6 w-24' />
        ) : (
          <h1 className='text-foreground text-xl font-medium'>{systemName}</h1>
        )}
      </Link>
      <div className='container relative z-10 flex items-center pt-16 sm:pt-0'>
        <div className='border-border/60 bg-card/70 mx-auto flex w-full flex-col justify-center space-y-2 rounded-2xl border px-4 py-8 shadow-2xl shadow-black/10 backdrop-blur-xl sm:w-[480px] sm:p-8 dark:shadow-black/40'>
          {children}
        </div>
      </div>
    </div>
  )
}
