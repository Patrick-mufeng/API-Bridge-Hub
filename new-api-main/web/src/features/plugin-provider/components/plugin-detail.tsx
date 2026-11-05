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

import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Download,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { installPlugin, uninstallPlugin } from '../api'
import type { MarketPlugin } from '../types'
import { PluginLogo } from './plugin-logo'

const KIND_LABEL: Record<string, string> = {
  provider: 'Subscription',
  middleware: 'Middleware',
  agent: 'Agent',
  tools: 'Tools',
  page: 'Page',
}

/** A number as a reader counts it: 12.4k, not 12403. */
function compact(n: number) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(n)
}

/** The install button's mark and word, in the state it is in. */
function InstallButtonBody(props: {
  busy: boolean
  installed: boolean
  t: (key: string) => string
}) {
  if (props.busy) {
    return (
      <>
        <Loader2
          data-icon='inline-start'
          className='animate-spin'
          aria-hidden='true'
        />
        {props.t('Working…')}
      </>
    )
  }
  if (props.installed) {
    return (
      <>
        <Trash2 data-icon='inline-start' aria-hidden='true' />
        {props.t('Remove')}
      </>
    )
  }
  return (
    <>
      <Download data-icon='inline-start' aria-hidden='true' />
      {props.t('Install')}
    </>
  )
}

/** One line of the fact table: a label and its value. */
function Fact({ label, value }: { label: string; value?: React.ReactNode }) {
  if (!value) {
    return null
  }
  return (
    <div className='flex items-baseline justify-between gap-3 py-0.5'>
      <span className='text-muted-foreground shrink-0 text-[11px]'>
        {label}
      </span>
      <span className='min-w-0 truncate text-right text-xs'>{value}</span>
    </div>
  )
}

/**
 * One plugin, opened: what it is, who wrote it, what it signs in to, and the
 * one thing to do with it.
 *
 * The facts are the ones an operator weighs before installing somebody
 * else's code — who published it, under what licence, how many use it, and
 * where its source is. Magpie lays this out the same way, and for the same
 * reason: the card has room for a name, and this is where the rest goes.
 */
export function PluginDetail({
  plugin,
  onClose,
}: {
  plugin: MarketPlugin
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const summary = plugin.summary?.[lang] ?? plugin.summary?.en ?? ''
  const description = summary || plugin.description || ''
  const installed = plugin.installed
  const behind =
    installed &&
    plugin.version &&
    plugin.installed_version &&
    plugin.version !== plugin.installed_version

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })

  const addMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await installPlugin(plugin.package)),
    onSuccess: () => {
      toast.success(t('Added {{name}}', { name: plugin.name }))
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  const removeMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await uninstallPlugin(plugin.package)),
    onSuccess: () => {
      toast.success(t('Removed {{name}}', { name: plugin.name }))
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  const busy = addMutation.isPending || removeMutation.isPending
  const kind = plugin.kind || 'provider'

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className='flex max-h-[85vh] flex-col sm:max-w-lg'>
        <DialogHeader className='gap-2'>
          <div className='flex items-start gap-2.5'>
            <PluginLogo name={plugin.icon} kind={plugin.kind} size='lg' />
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-1.5'>
                <span className='truncate text-sm font-semibold'>
                  {plugin.name}
                </span>
                {plugin.community ? (
                  <Badge variant='secondary' className='shrink-0 gap-1'>
                    <ShieldCheck className='size-3' aria-hidden='true' />
                    {t('community')}
                  </Badge>
                ) : null}
              </div>
              <div className='text-muted-foreground truncate font-mono text-[11px]'>
                {plugin.publisher ? `${plugin.publisher} · ` : ''}
                {plugin.package}
              </div>
            </div>
            <Button
              variant={installed ? 'ghost' : 'default'}
              size='sm'
              className='shrink-0'
              disabled={busy}
              onClick={() =>
                installed ? removeMutation.mutate() : addMutation.mutate()
              }
            >
              <InstallButtonBody busy={busy} installed={installed} t={t} />
            </Button>
          </div>
        </DialogHeader>

        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto pr-1'>
          {description ? (
            <p className='text-muted-foreground text-xs leading-relaxed'>
              {description}
            </p>
          ) : null}

          <div className='flex flex-wrap items-center gap-1.5'>
            <Badge variant='outline'>
              {t(KIND_LABEL[kind] ?? 'Subscription')}
            </Badge>
            {installed && plugin.installed_version ? (
              <Badge variant='secondary' className='font-mono'>
                {behind
                  ? `v${plugin.installed_version} → v${plugin.version}`
                  : `v${plugin.installed_version}`}
              </Badge>
            ) : null}
            {plugin.replaces ? (
              <Badge variant='outline'>
                {t('takes the place of {{name}}', { name: plugin.replaces })}
              </Badge>
            ) : null}
          </div>

          <div className='bg-muted/30 rounded-md px-2.5 py-1.5'>
            <Fact
              label={t('Version')}
              value={plugin.version && `v${plugin.version}`}
            />
            <Fact
              label={t('Downloads')}
              value={
                plugin.weekly
                  ? t('{{n}}/week', { n: compact(plugin.weekly) })
                  : ''
              }
            />
            <Fact label={t('License')} value={plugin.license} />
            <Fact
              label={t('Signs in to')}
              value={
                plugin.providers?.length ? plugin.providers.join(', ') : ''
              }
            />
          </div>

          {plugin.providers?.length ? (
            <p className='text-muted-foreground text-[11px]'>
              {t(
                'Sign in to it from the Providers tab; each account then becomes a key of one channel.'
              )}
            </p>
          ) : null}

          <div className='flex flex-wrap items-center gap-2'>
            <a
              href={`https://www.npmjs.com/package/${plugin.package}`}
              target='_blank'
              rel='noreferrer'
              className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline'
            >
              npm
              <ExternalLink className='size-2.5' aria-hidden='true' />
            </a>
            {plugin.repository ? (
              <a
                href={plugin.repository}
                target='_blank'
                rel='noreferrer'
                className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline'
              >
                {t('Source')}
                <ExternalLink className='size-2.5' aria-hidden='true' />
              </a>
            ) : null}
            {plugin.homepage && plugin.homepage !== plugin.repository ? (
              <a
                href={plugin.homepage}
                target='_blank'
                rel='noreferrer'
                className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline'
              >
                {t('Homepage')}
                <ExternalLink className='size-2.5' aria-hidden='true' />
              </a>
            ) : null}
          </div>

          {!plugin.community ? (
            <p className={cn('text-muted-foreground flex gap-1.5 text-[11px]')}>
              <ShieldCheck
                className='mt-0.5 size-3 shrink-0'
                aria-hidden='true'
              />
              {t(
                'Not written by the community: nobody here has reviewed it. It runs with your sign-ins and your requests.'
              )}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant='outline' size='sm' onClick={onClose}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
