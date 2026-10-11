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
import { RefreshCw, Server, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { handleServerError } from '@/lib/handle-server-error'
import {
  createServerError,
  requireServerSuccess,
} from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  buildReverseProxyService,
  listReverseProxyServices,
  registerReverseProxyChannel,
  reloadReverseProxyServices,
  restartReverseProxyService,
  startReverseProxyService,
  stopReverseProxyService,
} from '../api'
import { REVERSE_PROXY_POLL_INTERVAL_MS } from '../constants'
import type { ReverseProxyService } from '../types'
import { KeyDialog } from './key-dialog'
import { LogsDialog } from './logs-dialog'
import { PanelDialog } from './panel-dialog'
import { ServiceCard, type ReverseProxyAction } from './service-card'

type PanelAction = ReverseProxyAction | 'reload'

type ActionInput = {
  action: PanelAction
  id?: string
}

async function runAction(input: ActionInput) {
  switch (input.action) {
    case 'reload':
      return reloadReverseProxyServices()
    case 'start':
      return startReverseProxyService(input.id ?? '')
    case 'stop':
      return stopReverseProxyService(input.id ?? '')
    case 'restart':
      return restartReverseProxyService(input.id ?? '')
    case 'build':
      return buildReverseProxyService(input.id ?? '')
    case 'channel':
      return registerReverseProxyChannel(input.id ?? '')
  }
}

function actionSuccessMessage(action: PanelAction, t: TFunction): string {
  switch (action) {
    case 'start':
      return t('Service started')
    case 'stop':
      return t('Service stopped')
    case 'restart':
      return t('Service restarted')
    case 'build':
      return t('Build finished')
    case 'channel':
      return t('Channel registered')
    case 'reload':
      return t('Manifests reloaded')
  }
}

export function ReverseProxyPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [logsTarget, setLogsTarget] = useState<ReverseProxyService | null>(null)
  const [panelTarget, setPanelTarget] = useState<ReverseProxyService | null>(
    null
  )
  const [keyTarget, setKeyTarget] = useState<ReverseProxyService | null>(null)

  const servicesQuery = useQuery({
    queryKey: ['reverse-proxy', 'services'],
    queryFn: async () => {
      const res = requireServerSuccess(await listReverseProxyServices())
      if (!res.data) {
        throw createServerError(
          res,
          t('We could not load reverse proxy services.')
        )
      }
      return res.data
    },
    refetchInterval: REVERSE_PROXY_POLL_INTERVAL_MS,
    retry: false,
  })

  const actionMutation = useMutation({
    mutationFn: async (input: ActionInput) =>
      requireServerSuccess(await runAction(input)),
    onSuccess: (_data, input) => {
      toast.success(actionSuccessMessage(input.action, t))
      void queryClient.invalidateQueries({ queryKey: ['reverse-proxy'] })
    },
    onError: (error) => {
      handleServerError(error)
      void queryClient.invalidateQueries({ queryKey: ['reverse-proxy'] })
    },
  })

  const handleAction = (action: ReverseProxyAction, id: string) => {
    actionMutation.mutate({ action, id })
  }

  if (servicesQuery.isLoading) {
    return <LoadingState message={t('Loading reverse proxy services...')} />
  }
  if (servicesQuery.isError || !servicesQuery.data) {
    return (
      <ErrorState
        title={t('We could not load reverse proxy services.')}
        description={
          servicesQuery.error instanceof Error
            ? servicesQuery.error.message
            : undefined
        }
        onRetry={() => void servicesQuery.refetch()}
      />
    )
  }

  const payload = servicesQuery.data
  const services = payload.services ?? []
  const loadErrors = payload.load_errors ?? []
  const refreshing = servicesQuery.isFetching && !servicesQuery.isLoading

  return (
    <div className='space-y-4'>
      {loadErrors.length > 0 ? (
        <div className='border-warning/40 bg-warning/10 text-warning rounded-md border p-3 text-xs'>
          <p className='font-medium'>{t('Manifest errors')}</p>
          <ul className='mt-1 list-disc space-y-0.5 pl-4'>
            {loadErrors.map((message) => (
              <li key={message} className='font-mono break-all'>
                {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className='bg-card overflow-hidden rounded-lg border shadow-xs'>
        <div className='flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2'>
              <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
                <Server className='size-4' aria-hidden='true' />
              </span>
              <div className='min-w-0'>
                <h3 className='text-sm font-semibold'>{t('Services')}</h3>
                <p className='text-muted-foreground mt-0.5 text-xs'>
                  {t(
                    'Local reverse proxy services described by manifests, with their relay channels and panels.'
                  )}
                </p>
              </div>
            </div>
          </div>
          <div className='flex shrink-0 flex-wrap items-center gap-2 sm:justify-end'>
            <span className='text-muted-foreground text-xs' aria-live='polite'>
              {t('Auto-refreshing every {{seconds}}s', {
                seconds: REVERSE_PROXY_POLL_INTERVAL_MS / 1000,
              })}
            </span>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void servicesQuery.refetch()}
              disabled={servicesQuery.isFetching}
            >
              <RefreshCw
                data-icon='inline-start'
                className={cn(refreshing && 'animate-spin')}
                aria-hidden='true'
              />
              {refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
            <Button
              size='sm'
              onClick={() => actionMutation.mutate({ action: 'reload' })}
              disabled={actionMutation.isPending}
            >
              <SlidersHorizontal data-icon='inline-start' aria-hidden='true' />
              {t('Reload manifests')}
            </Button>
          </div>
        </div>

        <div className='space-y-4 p-4 sm:p-5' aria-busy={refreshing}>
          {services.length === 0 ? (
            <EmptyState
              title={t('No reverse proxy services found.')}
              description={t(
                'Drop a JSON manifest into the services directory and reload.'
              )}
            />
          ) : (
            <div className='grid gap-4 xl:grid-cols-2'>
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  busy={
                    actionMutation.isPending &&
                    actionMutation.variables?.id === service.id
                  }
                  onAction={handleAction}
                  onShowLogs={setLogsTarget}
                  onShowPanel={setPanelTarget}
                  onShowKey={setKeyTarget}
                />
              ))}
            </div>
          )}

          <p className='text-muted-foreground font-mono text-xs break-all'>
            {t('Manifest directory')}: {payload.services_dir}
          </p>
        </div>
      </section>

      <LogsDialog
        service={logsTarget}
        open={logsTarget !== null}
        onOpenChange={(open) => {
          if (!open) setLogsTarget(null)
        }}
      />
      <PanelDialog
        service={panelTarget}
        open={panelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPanelTarget(null)
        }}
      />
      <KeyDialog
        service={keyTarget}
        open={keyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setKeyTarget(null)
        }}
      />
    </div>
  )
}
