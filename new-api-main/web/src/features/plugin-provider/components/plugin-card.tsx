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
import { Check, Download, Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { installPlugin, uninstallPlugin } from '../api'
import type { MarketPlugin } from '../types'
import { PluginLogo } from './plugin-logo'

/** What each kind of package is, in a word. */
const KIND_LABEL: Record<string, string> = {
  provider: 'Subscription',
  middleware: 'Middleware',
  agent: 'Agent',
  tools: 'Tools',
  page: 'Page',
}

function summaryOf(plugin: MarketPlugin, lang: string) {
  if (!plugin.summary) {
    return ''
  }
  return plugin.summary[lang] ?? plugin.summary.en ?? ''
}

/**
 * One plugin in the market. A subscription signs in from the Providers
 * page, not here: this is where it is added or removed.
 */
export function PluginCard({
  plugin,
  onOpen,
}: {
  plugin: MarketPlugin
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const summary = summaryOf(plugin, lang)
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

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'bg-card hover:border-primary/40 flex cursor-pointer flex-col gap-2 rounded-lg border p-3 shadow-xs transition-colors',
        installed && 'border-primary/40'
      )}
    >
      <div className='flex items-start gap-2'>
        <PluginLogo name={plugin.icon} kind={plugin.kind} />
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='text-sm font-semibold'>{plugin.name}</span>
            {plugin.community ? (
              <Badge variant='secondary' className='gap-1'>
                <Check className='size-3' aria-hidden='true' />
                {t('community')}
              </Badge>
            ) : null}
          </div>
          <div className='text-muted-foreground mt-0.5 truncate font-mono text-[11px]'>
            {plugin.package}
          </div>
        </div>
        <Button
          variant={installed ? 'ghost' : 'default'}
          size='sm'
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            if (installed) {
              removeMutation.mutate()
            } else {
              addMutation.mutate()
            }
          }}
          title={
            installed
              ? t(
                  'Take it out of this relay; its accounts stay signed in on disk.'
                )
              : t('Download it and add it to this relay.')
          }
        >
          <InstallIcon busy={busy} installed={installed} />
          {installWords(busy, installed, t)}
        </Button>
      </div>

      {summary ? (
        <p className='text-muted-foreground line-clamp-2 text-xs'>{summary}</p>
      ) : null}

      <div className='mt-auto flex flex-wrap items-center gap-1.5'>
        <Badge variant='outline'>
          {t(KIND_LABEL[plugin.kind || 'provider'] ?? 'Subscription')}
        </Badge>
        {plugin.providers?.length ? (
          <span className='text-muted-foreground font-mono text-[11px]'>
            {plugin.providers.join(', ')}
          </span>
        ) : null}
        <span className='grow' />
        <VersionNote
          behind={Boolean(behind)}
          installed={plugin.installed_version}
          latest={plugin.version}
        />
      </div>
    </div>
  )
}

/** What the button shows while it works, after, and before. */
function InstallIcon(props: { busy: boolean; installed: boolean }) {
  if (props.busy) {
    return (
      <Loader2
        data-icon='inline-start'
        className='animate-spin'
        aria-hidden='true'
      />
    )
  }
  if (props.installed) {
    return <Trash2 data-icon='inline-start' aria-hidden='true' />
  }
  return <Download data-icon='inline-start' aria-hidden='true' />
}

/** The button's own word, in the state it is in. */
function installWords(
  busy: boolean,
  installed: boolean,
  t: (key: string) => string
) {
  if (busy) {
    return t('Working…')
  }
  if (installed) {
    return t('Remove')
  }
  return t('Install')
}

/** The version it is on, or the one it is behind by. */
function VersionNote(props: {
  behind: boolean
  installed?: string
  latest?: string
}) {
  if (props.behind) {
    return (
      <Badge variant='secondary' className='font-mono'>
        v{props.installed} → v{props.latest}
      </Badge>
    )
  }
  if (!props.latest) {
    return null
  }
  return (
    <span className='text-muted-foreground font-mono text-[11px]'>
      v{props.installed || props.latest}
    </span>
  )
}
