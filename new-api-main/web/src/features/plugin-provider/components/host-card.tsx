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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDrive, RefreshCw, ShieldCheck, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { listPluginHost, updatePluginHost } from '../api'

/**
 * The plugin host's own state: whether it runs, where it keeps its files,
 * whether Bun is here, and which registry plugins come from.
 */
export function HostCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const hostQuery = useQuery({
    queryKey: ['plugin-provider', 'host'],
    queryFn: async () => requireServerSuccess(await listPluginHost()).data,
    retry: false,
  })

  const updateMutation = useMutation({
    mutationFn: async (input: { enabled?: boolean; china_mirror?: boolean }) =>
      requireServerSuccess(await updatePluginHost(input)),
    onSuccess: () => {
      toast.success(t('Plugin host updated'))
      void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })
    },
    onError: (error) => handleServerError(error),
  })

  const host = hostQuery.data
  if (!host) {
    return null
  }

  return (
    <section className='bg-card overflow-hidden rounded-lg border shadow-xs'>
      <div className='flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5'>
        <div className='flex items-center gap-2'>
          <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
            <Terminal className='size-4' aria-hidden='true' />
          </span>
          <div className='min-w-0'>
            <h3 className='text-sm font-semibold'>{t('Plugin host')}</h3>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              {t(
                'Community plugins sign a vendor subscription in and make its requests. One Bun process runs them all.'
              )}
            </p>
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant={host.running ? 'default' : 'outline'}>
            {host.running ? t('Running') : t('Stopped')}
          </Badge>
          <Badge variant='outline'>
            {t('{{count}} plugins', { count: host.plugin_count })}
          </Badge>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void hostQuery.refetch()}
            disabled={hostQuery.isFetching}
          >
            <RefreshCw
              data-icon='inline-start'
              className={cn(hostQuery.isFetching && 'animate-spin')}
              aria-hidden='true'
            />
            {t('Refresh')}
          </Button>
        </div>
      </div>

      <div className='grid gap-4 p-4 sm:grid-cols-2 sm:p-5'>
        <div className='flex items-start justify-between gap-3 rounded-md border p-3'>
          <div className='min-w-0'>
            <p className='text-sm font-medium'>{t('Enable plugins')}</p>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              {t(
                'Off, no Bun starts and no plugin provider is offered. Existing channels keep working until the host stops.'
              )}
            </p>
          </div>
          <Switch
            checked={host.enabled}
            onCheckedChange={(checked) =>
              updateMutation.mutate({ enabled: checked })
            }
            disabled={updateMutation.isPending}
          />
        </div>

        <div className='flex items-start justify-between gap-3 rounded-md border p-3'>
          <div className='min-w-0'>
            <p className='text-sm font-medium'>{t('China mirror')}</p>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              {t(
                'Asks npmmirror and jsDelivr before npm and GitHub, for the addresses one serves byte for byte.'
              )}
            </p>
          </div>
          <Switch
            checked={host.china_mirror}
            onCheckedChange={(checked) =>
              updateMutation.mutate({ china_mirror: checked })
            }
            disabled={updateMutation.isPending}
          />
        </div>

        <div className='rounded-md border p-3 sm:col-span-2'>
          <div className='flex flex-wrap items-center gap-x-6 gap-y-2 text-xs'>
            <span className='inline-flex items-center gap-1.5'>
              <HardDrive
                className='text-muted-foreground size-3.5'
                aria-hidden='true'
              />
              <span className='text-muted-foreground'>{t('Files')}</span>
              <span className='font-mono break-all'>{host.config_dir}</span>
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <ShieldCheck
                className='text-muted-foreground size-3.5'
                aria-hidden='true'
              />
              <span className='text-muted-foreground'>{t('Sign-ins')}</span>
              <span className='font-mono break-all'>{host.auth_path}</span>
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <Badge variant={host.bun_cached ? 'secondary' : 'outline'}>
                {host.bun_cached
                  ? t('Bun ready')
                  : t('Bun downloads on first use')}
              </Badge>
            </span>
            {host.npm_registry ? (
              <span className='text-muted-foreground'>
                {t('Registry')}:{' '}
                <span className='font-mono'>{host.npm_registry}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
