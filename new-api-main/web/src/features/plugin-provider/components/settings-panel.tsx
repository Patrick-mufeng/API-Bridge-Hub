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
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  getPluginProvider,
  migratePluginPrefixes,
  setPluginProviderOption,
} from '../api'
import type { PluginModel, PluginOption } from '../types'
import { NotProvided } from './not-provided'

/**
 * The switches a provider's plugin declares for it, as the plugin names
 * them: WorkBuddy's "free models only" is one, and a plugin that declares
 * none leaves this panel saying so rather than empty.
 *
 * A switch belongs to the vendor's own contract, so its label and its
 * description come from the plugin, in the reader's language when the plugin
 * gave one. Only the frame around them is this console's.
 */
/** What a model badge says when it is hovered: both of its names. */
function modelTitle(
  model: PluginModel,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  const parts = []
  if (model.relay_name && model.relay_name !== model.id) {
    parts.push(t('upstream id: {{id}}', { id: model.id }))
  }
  if (model.context) {
    parts.push(t('{{n}} token context', { n: model.context }))
  }
  if (model.output) {
    parts.push(t('{{n}} token output', { n: model.output }))
  }
  return parts.join(' · ') || undefined
}

export function SettingsPanel(props: {
  provider: string
  /** The switches the plugin declares; undefined until the detail loads. */
  optionsOffered?: PluginOption[]
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const lang = i18n.language || 'en'

  const detailQuery = useQuery({
    queryKey: ['plugin-provider', 'detail', props.provider],
    queryFn: async () =>
      requireServerSuccess(await getPluginProvider(props.provider)).data,
    retry: false,
  })

  // renaming the channels' models to the namespaced form: what makes two
  // providers serving one model id two names rather than one
  const migrateMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await migratePluginPrefixes(false)),
    onSuccess: (res) => {
      const n = res.data?.migrated?.length ?? 0
      toast.success(t('Renamed the models of {{n}} channel(s)', { n }))
      void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })
    },
    onError: (error) => handleServerError(error),
  })

  const optionMutation = useMutation({
    mutationFn: async (input: { key: string; on: boolean }) =>
      requireServerSuccess(
        await setPluginProviderOption(props.provider, input.key, input.on)
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })
    },
    onError: (error) => handleServerError(error),
  })

  if (detailQuery.isLoading) {
    return <LoadingState message={t('Reading settings…')} />
  }

  const options: PluginOption[] = detailQuery.data?.options ?? []
  const models = detailQuery.data?.models ?? []
  // a channel made before names were namespaced serves the vendor's own ids,
  // which two providers can both answer for: say so, and offer the rename
  const prefix = detailQuery.data?.prefix ?? ''

  /** What the plugin calls a switch, in the reader's language when it can. */
  const labelOf = (option: PluginOption) =>
    option.labels?.[lang] ??
    option.labels?.[lang.split('-')[0]] ??
    option.label ??
    option.key

  const descriptionOf = (option: PluginOption) =>
    option.descriptions?.[lang] ??
    option.descriptions?.[lang.split('-')[0]] ??
    option.description ??
    ''

  return (
    <div className='space-y-3'>
      <section className='space-y-1.5'>
        <h4 className='text-xs font-semibold'>{t('Plugin settings')}</h4>
        {options.length === 0 ? (
          <NotProvided
            what={t('Settings')}
            detail={t(
              'This plugin declares no switch of its own, so there is nothing to set here.'
            )}
            hook='auth.options'
          />
        ) : (
          <div className='space-y-1.5'>
            {options.map((option) => (
              <div
                key={option.key}
                className='flex flex-wrap items-start justify-between gap-2 rounded-md border px-2.5 py-2'
              >
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-1.5'>
                    <span className='text-xs font-medium'>
                      {labelOf(option)}
                    </span>
                    <Badge variant='outline' className='font-mono text-[10px]'>
                      {option.key}
                    </Badge>
                    {option.value !== option.default ? (
                      <Badge variant='secondary' className='text-[10px]'>
                        {t('Changed')}
                      </Badge>
                    ) : null}
                  </div>
                  {descriptionOf(option) ? (
                    <p className='text-muted-foreground mt-0.5 text-[11px]'>
                      {descriptionOf(option)}
                    </p>
                  ) : null}
                  {option.confirm ? (
                    <p className='text-muted-foreground/80 mt-0.5 text-[10px] italic'>
                      {option.confirm}
                    </p>
                  ) : null}
                </div>
                <Switch
                  checked={option.value}
                  disabled={optionMutation.isPending}
                  onCheckedChange={(on) =>
                    optionMutation.mutate({ key: option.key, on })
                  }
                  aria-label={labelOf(option)}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className='space-y-1.5'>
        <h4 className='text-xs font-semibold'>
          {t('Models served')}
          <span className='text-muted-foreground ml-1 font-normal'>
            · {models.length}
          </span>
        </h4>
        {prefix === '' ? (
          <NamespaceNotice
            onMigrate={() => migrateMutation.mutate()}
            busy={migrateMutation.isPending}
          />
        ) : null}
        {models.length === 0 ? (
          <p className='text-muted-foreground rounded-md border px-2.5 py-2 text-xs'>
            {t('This provider lists no model yet.')}
          </p>
        ) : (
          <>
            <p className='text-muted-foreground text-[11px]'>
              {t(
                'Its models, with their thinking depths, credits and limits, are on the Models tab.'
              )}
            </p>
            <div className='flex flex-wrap gap-1'>
              {models.slice(0, 12).map((model) => (
                <Badge
                  key={model.id}
                  variant='outline'
                  className={cn(
                    'font-mono text-[10px]',
                    model.free && 'border-emerald-500/40 text-emerald-600'
                  )}
                  title={modelTitle(model, t)}
                >
                  {model.free ? (
                    <Sparkles className='mr-0.5 size-2.5' aria-hidden='true' />
                  ) : null}
                  {model.relay_name || model.id}
                </Badge>
              ))}
              {models.length > 12 ? (
                <Badge variant='secondary' className='text-[10px]'>
                  {t('and {{n}} more', { n: models.length - 12 })}
                </Badge>
              ) : null}
            </div>
          </>
        )}
      </section>

      {optionMutation.isPending ? (
        <p className='text-muted-foreground flex items-center gap-1 text-[10px]'>
          <Loader2 className='size-3 animate-spin' aria-hidden='true' />
          {t('Saving…')}
        </p>
      ) : null}
    </div>
  )
}

/** What an unnamespaced provider's models mean, and the way to fix it. */
function NamespaceNotice(props: { onMigrate: () => void; busy: boolean }) {
  const { t } = useTranslation()
  return (
    <div className='rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2'>
      <p className='text-xs font-medium'>
        {t('These models are served without a namespace')}
      </p>
      <p className='text-muted-foreground mt-0.5 text-[11px]'>
        {t(
          'A client asks for the bare id, so two providers serving one model id answer for the same name and a request goes to whichever is first. Renaming them gives each provider its own namespace, and the old names keep working as aliases.'
        )}
      </p>
      <Button
        size='sm'
        variant='outline'
        className='mt-1.5'
        disabled={props.busy}
        onClick={props.onMigrate}
      >
        {props.busy ? (
          <Loader2
            data-icon='inline-start'
            className='animate-spin'
            aria-hidden='true'
          />
        ) : (
          <RefreshCw data-icon='inline-start' aria-hidden='true' />
        )}
        {t('Give them a namespace')}
      </Button>
    </div>
  )
}
