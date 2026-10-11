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

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Input } from '@/components/ui/input'
import { requireServerSuccess } from '@/lib/server-error-message'

import { revealReverseProxyServiceKey } from '../api'
import type { ReverseProxyService } from '../types'

interface KeyDialogProps {
  service: ReverseProxyService | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function KeyDialog(props: KeyDialogProps) {
  const { t } = useTranslation()
  const service = props.service
  const keyQuery = useQuery({
    queryKey: ['reverse-proxy', 'key', service?.id],
    queryFn: async () => {
      if (!service) {
        throw new Error('no service selected')
      }
      const res = requireServerSuccess(
        await revealReverseProxyServiceKey(service.id)
      )
      return res.data?.key ?? ''
    },
    enabled: props.open && !!service,
    retry: false,
  })

  if (!service) return null

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Service API key')}
      description={service.name}
    >
      {keyQuery.isLoading ? <LoadingState message={t('Loading...')} /> : null}
      {keyQuery.isError ? (
        <ErrorState
          title={t('We could not read the service API key.')}
          description={
            keyQuery.error instanceof Error
              ? keyQuery.error.message
              : undefined
          }
          onRetry={() => void keyQuery.refetch()}
        />
      ) : null}
      {keyQuery.data ? (
        <div className='space-y-2'>
          <div className='flex items-center gap-2'>
            <Input readOnly value={keyQuery.data} className='font-mono' />
            <CopyButton value={keyQuery.data} aria-label={t('Copy')} />
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'The embedded panel receives this key automatically; copy it only for other clients.'
            )}
          </p>
        </div>
      ) : null}
    </Dialog>
  )
}
