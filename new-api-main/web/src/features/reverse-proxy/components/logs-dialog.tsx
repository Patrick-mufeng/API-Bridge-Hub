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

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getReverseProxyServiceLogs } from '../api'
import type { ReverseProxyService } from '../types'

const LOG_LINES = 300
const LOG_POLL_INTERVAL_MS = 3000

interface LogsDialogProps {
  service: ReverseProxyService | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LogsDialog(props: LogsDialogProps) {
  const { t } = useTranslation()
  const service = props.service
  const logsQuery = useQuery({
    queryKey: ['reverse-proxy', 'logs', service?.id],
    queryFn: async () => {
      if (!service) {
        throw new Error('no service selected')
      }
      const res = requireServerSuccess(
        await getReverseProxyServiceLogs(service.id, LOG_LINES)
      )
      return res.data?.log ?? ''
    },
    enabled: props.open && !!service,
    refetchInterval: props.open ? LOG_POLL_INTERVAL_MS : false,
    retry: false,
  })

  if (!service) return null

  let body = null
  if (logsQuery.isLoading) {
    body = <LoadingState message={t('Loading logs...')} />
  } else if (logsQuery.isError) {
    body = (
      <ErrorState
        title={t('We could not load the service log.')}
        description={
          logsQuery.error instanceof Error
            ? logsQuery.error.message
            : undefined
        }
        onRetry={() => void logsQuery.refetch()}
      />
    )
  } else if (!logsQuery.data) {
    body = (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        {t('No log output yet.')}
      </p>
    )
  } else {
    body = (
      <pre className='bg-muted/40 max-h-[65vh] overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap'>
        {logsQuery.data}
      </pre>
    )
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={service.name}
      description={t('Service log · auto-refreshing every {{seconds}}s', {
        seconds: LOG_POLL_INTERVAL_MS / 1000,
      })}
      contentClassName='sm:max-w-4xl'
    >
      {body}
    </Dialog>
  )
}
