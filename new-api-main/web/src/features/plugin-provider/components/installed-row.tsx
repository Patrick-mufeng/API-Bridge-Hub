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
import { Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { setPluginOff, uninstallPlugin } from '../api'
import type { InstalledPlugin } from '../types'

/**
 * One installed plugin, as a row: what it is, the version, whether a newer
 * one is out, and the three things that can be done to it.
 *
 * Switching one off leaves it installed and on disk: a middleware that
 * misbehaves is switched off rather than removed, and so is a subscription
 * whose account lapsed for a while.
 */
export function InstalledRow({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })

  const offMutation = useMutation({
    mutationFn: async (off: boolean) =>
      requireServerSuccess(await setPluginOff(plugin.spec, off)),
    onSuccess: () => refresh(),
    onError: (error) => handleServerError(error),
  })

  const removeMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await uninstallPlugin(plugin.spec)),
    onSuccess: () => {
      toast.success(t('Removed {{name}}', { name: plugin.name }))
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2',
        plugin.off && 'opacity-60'
      )}
    >
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='text-sm font-medium'>{plugin.name}</span>
          {plugin.version ? (
            <span className='text-muted-foreground font-mono text-[11px]'>
              v{plugin.version}
            </span>
          ) : null}
          {plugin.update ? (
            <Badge variant='secondary' className='font-mono'>
              {t('v{{v}} out', { v: plugin.update })}
            </Badge>
          ) : null}
          {plugin.off ? <Badge variant='outline'>{t('Off')}</Badge> : null}
          {plugin.load_error ? (
            <Badge variant='destructive'>{t('Failed to load')}</Badge>
          ) : null}
        </div>
        <div className='text-muted-foreground mt-0.5 truncate font-mono text-[11px]'>
          {plugin.spec}
          {plugin.providers?.length ? ` · ${plugin.providers.join(', ')}` : ''}
        </div>
        {plugin.load_error ? (
          <p className='text-destructive mt-0.5 text-xs'>{plugin.load_error}</p>
        ) : null}
      </div>

      <div className='flex shrink-0 items-center gap-2'>
        <Switch
          checked={!plugin.off}
          disabled={offMutation.isPending}
          onCheckedChange={(on) => offMutation.mutate(!on)}
          aria-label={t('On')}
        />
        <Button
          variant='ghost'
          size='sm'
          disabled={removeMutation.isPending}
          onClick={() => removeMutation.mutate()}
          aria-label={t('Remove')}
        >
          {removeMutation.isPending ? (
            <Loader2
              data-icon='inline-start'
              className='animate-spin'
              aria-hidden='true'
            />
          ) : (
            <Trash2 data-icon='inline-start' aria-hidden='true' />
          )}
        </Button>
      </div>
    </div>
  )
}
