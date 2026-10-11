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
import {
  FileText,
  Hammer,
  KeyRound,
  Link2,
  Monitor,
  Play,
  RotateCw,
  Square,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { ReverseProxyService } from '../types'

export type ReverseProxyAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'build'
  | 'channel'

interface ServiceCardProps {
  service: ReverseProxyService
  busy: boolean
  onAction: (action: ReverseProxyAction, id: string) => void
  onShowLogs: (service: ReverseProxyService) => void
  onShowPanel: (service: ReverseProxyService) => void
  onShowKey: (service: ReverseProxyService) => void
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className='min-w-0'>
      <dt className='text-muted-foreground'>{props.label}</dt>
      <dd className='mt-0.5 truncate font-medium'>{props.children}</dd>
    </div>
  )
}

export function ServiceCard(props: ServiceCardProps) {
  const { t } = useTranslation()
  const service = props.service

  let statusVariant: 'success' | 'warning' | 'neutral' = 'neutral'
  let statusLabel = t('Stopped')
  if (!service.enabled) {
    statusLabel = t('Disabled')
  } else if (service.status.running) {
    if (service.status.healthy) {
      statusVariant = 'success'
      statusLabel = t('Running')
    } else {
      statusVariant = 'warning'
      statusLabel = t('Unhealthy')
    }
  }

  let statusDetail: ReactNode = null
  if (service.enabled && service.status.detail) {
    const unhealthy = service.status.running && !service.status.healthy
    statusDetail = (
      <p className={cn('text-xs', unhealthy ? 'text-warning' : 'text-muted-foreground')}>
        {service.status.detail}
      </p>
    )
  }

  return (
    <section className='bg-card flex flex-col gap-4 rounded-lg border p-4 shadow-xs'>
      <header className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex min-w-0 items-center gap-2'>
            <h3 className='truncate text-sm font-semibold'>{service.name}</h3>
            <StatusBadge
              variant={statusVariant}
              label={statusLabel}
              pulse={service.status.running && service.status.healthy}
            />
          </div>
          {service.description ? (
            <p className='text-muted-foreground mt-1 text-xs'>
              {service.description}
            </p>
          ) : null}
        </div>
        <span className='text-muted-foreground shrink-0 font-mono text-xs'>
          {service.host}:{service.port}
        </span>
      </header>

      <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3'>
        <Field label={t('PID')}>
          {service.status.pid > 0 ? service.status.pid : '—'}
        </Field>
        <Field label={t('Channel')}>
          {service.channel.registered ? (
            <Link
              to='/channels'
              className='text-primary hover:underline'
              title={service.channel.name}
            >
              {t('{{count}} models', {
                count: service.channel.models ?? 0,
              })}
            </Link>
          ) : (
            <span className='text-muted-foreground'>{t('Not registered')}</span>
          )}
        </Field>
        <Field label={t('Model prefix')}>
          {service.model_prefix ? (
            <span className='font-mono'>{service.model_prefix}</span>
          ) : (
            <span className='text-muted-foreground'>{t('None')}</span>
          )}
        </Field>
        <Field label={t('API key')}>
          {service.key_masked ? (
            <span className='font-mono'>{service.key_masked}</span>
          ) : (
            <span className='text-muted-foreground'>{t('Unavailable')}</span>
          )}
        </Field>
        <Field label={t('Workdir')}>
          <span className='font-mono' title={service.workdir}>
            {service.workdir}
          </span>
        </Field>
        <Field label={t('Command')}>
          <span className='font-mono' title={service.command}>
            {service.command}
          </span>
        </Field>
        <Field label={t('Manifest')}>
          <span className='font-mono' title={service.manifest_path}>
            {service.id}.json
          </span>
        </Field>
      </dl>

      {service.key_error ? (
        <p className='text-warning text-xs'>{service.key_error}</p>
      ) : null}
      {statusDetail}

      <div className='mt-auto flex flex-wrap items-center gap-2'>
        {service.status.running ? (
          <>
            <Button
              variant='outline'
              size='sm'
              disabled={props.busy}
              onClick={() => props.onAction('stop', service.id)}
            >
              <Square data-icon='inline-start' aria-hidden='true' />
              {t('Stop')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={props.busy}
              onClick={() => props.onAction('restart', service.id)}
            >
              <RotateCw data-icon='inline-start' aria-hidden='true' />
              {t('Restart')}
            </Button>
          </>
        ) : (
          <Button
            size='sm'
            disabled={props.busy || !service.enabled}
            onClick={() => props.onAction('start', service.id)}
          >
            <Play data-icon='inline-start' aria-hidden='true' />
            {t('Start')}
          </Button>
        )}
        <Button
          variant='outline'
          size='sm'
          disabled={props.busy}
          onClick={() => props.onAction('build', service.id)}
          className={cn(!service.build_ready && 'border-warning/60')}
          title={service.build_ready ? undefined : t('Not built yet')}
        >
          <Hammer data-icon='inline-start' aria-hidden='true' />
          {t('Build')}
        </Button>
        <Button
          variant='outline'
          size='sm'
          disabled={props.busy}
          onClick={() => props.onAction('channel', service.id)}
        >
          <Link2 data-icon='inline-start' aria-hidden='true' />
          {t('Register channel')}
        </Button>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => props.onShowLogs(service)}
        >
          <FileText data-icon='inline-start' aria-hidden='true' />
          {t('Logs')}
        </Button>
        {service.panel_url ? (
          <Button
            variant='ghost'
            size='sm'
            disabled={!service.status.running}
            onClick={() => props.onShowPanel(service)}
          >
            <Monitor data-icon='inline-start' aria-hidden='true' />
            {t('Panel')}
          </Button>
        ) : null}
        <Button
          variant='ghost'
          size='sm'
          disabled={!service.key_masked}
          onClick={() => props.onShowKey(service)}
        >
          <KeyRound data-icon='inline-start' aria-hidden='true' />
          {t('Reveal key')}
        </Button>
      </div>
    </section>
  )
}
