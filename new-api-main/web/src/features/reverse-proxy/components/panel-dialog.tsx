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
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { createReverseProxyPanelTicket } from '../api'
import type { ReverseProxyService } from '../types'

interface PanelDialogProps {
  service: ReverseProxyService | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PanelDialog(props: PanelDialogProps) {
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard()
  const [embedUrl, setEmbedUrl] = useState('')
  const [frameKey, setFrameKey] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const serviceId = props.service?.id

  useEffect(() => {
    if (!props.open || !serviceId) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    setEmbedUrl('')
    void createReverseProxyPanelTicket(serviceId)
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data?.embed_url) {
          setEmbedUrl(res.data.embed_url)
          setFrameKey((key) => key + 1)
        } else {
          setError(res.message || t('Panel failed to load.'))
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('Panel failed to load.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.open, serviceId, t])

  if (!props.service) return null

  const panelUrl = props.service.panel_url

  let body = <EmptyState title={t('Panel unavailable')} />
  if (loading) {
    body = <LoadingState message={t('Loading panel...')} />
  } else if (error) {
    body = <ErrorState title={t('Panel failed to load.')} description={error} />
  } else if (embedUrl) {
    // The framed document is this relay's own same-origin proxy of a local
    // service panel: it must run scripts and keep same-origin access to reach
    // its APIs, which the sandbox rule reports as an escape.
    /* oxlint-disable react/iframe-missing-sandbox */
    body = (
      <iframe
        key={frameKey}
        src={embedUrl}
        title={t('Reverse proxy service panel')}
        sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
        className='h-full min-h-[60vh] w-full rounded-md border bg-background'
      />
    )
    /* oxlint-enable react/iframe-missing-sandbox */
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.service.name}
      description={t('Service panel')}
      contentClassName='sm:max-w-[min(1400px,94vw)]'
      contentHeight={loading || error ? 'auto' : '72vh'}
      footer={
        <>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setFrameKey((key) => key + 1)}
            disabled={!embedUrl}
          >
            <RefreshCw data-icon='inline-start' aria-hidden='true' />
            {t('Refresh')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              if (panelUrl) void copyToClipboard(panelUrl)
            }}
            disabled={!panelUrl}
          >
            {t('Copy panel URL')}
          </Button>
          {panelUrl ? (
            <Button
              size='sm'
              render={
                <a href={panelUrl} target='_blank' rel='noreferrer noopener' />
              }
            >
              <ExternalLink data-icon='inline-start' aria-hidden='true' />
              {t('Open in new tab')}
            </Button>
          ) : null}
        </>
      }
    >
      {body}
    </Dialog>
  )
}
