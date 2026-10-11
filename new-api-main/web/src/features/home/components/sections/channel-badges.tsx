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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { requireServerSuccess } from '@/lib/server-error-message'
import { getUserModels } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

// The reverse-proxy services behind this relay. Keep in sync with
// data/reverse-proxy/services/*.json manifests.
const RELAY_CHANNELS = [
  { name: 'WorkBuddy', prefix: 'wb:' },
  { name: 'Qoder', prefix: 'qd:' },
  { name: 'Cline', prefix: 'cl:' },
  { name: 'OpenCodeZ', prefix: 'ocz:' },
  { name: 'Trae', prefix: 'tr:' },
  { name: 'CmdGo', prefix: 'cg:' },
]

export function ChannelBadges() {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)

  const modelsQuery = useQuery({
    queryKey: ['home', 'user-models'],
    queryFn: async () => requireServerSuccess(await getUserModels()),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const modelCount = modelsQuery.data?.data?.length ?? 0

  return (
    <section className='relative z-10 px-6 pb-6'>
      <div className='bg-card/40 mx-auto max-w-4xl rounded-xl border p-5 backdrop-blur-sm'>
        <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
          <div className='text-sm font-semibold'>{t('Relay Channels')}</div>
          <div className='text-muted-foreground text-xs'>
            {isAuthenticated
              ? t('You have {{count}} models available', {
                  count: modelCount,
                })
              : t('Sign in to see your available models.')}
          </div>
        </div>
        <div className='mt-3 flex flex-wrap gap-2'>
          {RELAY_CHANNELS.map((channel) => (
            <span
              key={channel.prefix}
              className='border-border/60 bg-muted/40 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs'
            >
              <span className='text-foreground/80 font-medium'>
                {channel.name}
              </span>
              <span className='text-muted-foreground font-mono'>
                {channel.prefix}
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
