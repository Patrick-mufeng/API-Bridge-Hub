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
import { Activity, Coins, Gauge, Timer } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber, formatNumber, formatUseTime } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { getPluginProviderUsage } from '../api'
import type { ProviderUsage, UsageModel } from '../types'
import { NotProvided } from './not-provided'
import { UsageTrendChart } from './usage-chart'

/**
 * The periods a page offers: how far back it reads, how wide one bucket is,
 * and the words on its switch.
 */
const PERIODS = [
  {
    id: '24h',
    hours: 24,
    granularity: 'hour' as const,
    label: 'Last 24 hours',
  },
  {
    id: '7d',
    hours: 24 * 7,
    granularity: 'day' as const,
    label: 'Last 7 days',
  },
  {
    id: '30d',
    hours: 24 * 30,
    granularity: 'day' as const,
    label: 'Last 30 days',
  },
  {
    id: 'all',
    hours: 24 * 90,
    granularity: 'day' as const,
    label: 'Last 90 days',
  },
]

/**
 * A provider's usage: what was spent through it, when, and by which model.
 *
 * The figures are the relay's own, read back by the channels the provider
 * was registered as. They sit beside the accounts' allowances because the
 * two answer one question together — how much of this subscription is left,
 * and what has been taken out of it.
 */
export function UsagePanel(props: { provider: string; offered?: boolean }) {
  const { t, i18n } = useTranslation()
  // A plugin that declares no usage hook has no allowance to report, so the
  // panel says so instead of drawing an empty chart. The distinction is the
  // plugin's: nothing is broken and nothing is still loading.
  if (props.offered === false) {
    return (
      <div className='space-y-2'>
        <NotProvided
          what={t('Usage')}
          detail={t(
            'This plugin reports no allowance, so there is no usage to draw.'
          )}
          hook='auth.usage'
        />
        <p className='text-muted-foreground text-[11px]'>
          {t(
            'What this hub relayed for the provider is still counted: it is on the Routing page, from the relay’s own records rather than the plugin’s.'
          )}
        </p>
      </div>
    )
  }
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [periodId, setPeriodId] = useState('7d')
  const period = PERIODS.find((p) => p.id === periodId) ?? PERIODS[1]

  const range = useMemo(() => {
    const end = Math.floor(Date.now() / 1000)
    return { start: end - period.hours * 3600, end }
  }, [period.hours])

  const usageQuery = useQuery({
    queryKey: [
      'plugin-provider',
      'usage',
      props.provider,
      period.id,
      Math.floor(range.end / 300),
    ],
    queryFn: async () =>
      requireServerSuccess(
        await getPluginProviderUsage(props.provider, {
          start_timestamp: range.start,
          end_timestamp: range.end,
          granularity: period.granularity,
        })
      ).data,
    retry: false,
  })

  if (usageQuery.isLoading) {
    return <LoadingState message={t('Reading usage…')} />
  }
  if (usageQuery.isError || !usageQuery.data) {
    return (
      <ErrorState
        title={t('We could not read this provider’s usage.')}
        description={
          usageQuery.error instanceof Error
            ? usageQuery.error.message
            : undefined
        }
        onRetry={() => void usageQuery.refetch()}
      />
    )
  }

  const usage = usageQuery.data
  const models = usage.models ?? []
  const channels = usage.channels ?? []

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div
          role='tablist'
          aria-label={t('Period')}
          className='bg-muted inline-flex rounded-md p-0.5'
        >
          {PERIODS.map((option) => (
            <button
              key={option.id}
              type='button'
              role='tab'
              aria-selected={periodId === option.id}
              onClick={() => setPeriodId(option.id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                periodId === option.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <span className='grow' />
        <Badge variant='outline' className='text-[10px]'>
          {usage.granularity === 'hour' ? t('By hour') : t('By day')}
        </Badge>
      </div>

      <MetricStrip usage={usage} locale={locale} />

      <section className='space-y-1.5'>
        <h4 className='text-xs font-semibold'>{t('Tokens over time')}</h4>
        <UsageTrendChart
          trend={usage.trend ?? []}
          granularity={usage.granularity}
        />
      </section>

      <section className='space-y-1.5'>
        <h4 className='text-xs font-semibold'>
          {t('Models')}
          <span className='text-muted-foreground ml-1 font-normal'>
            · {models.length}
          </span>
        </h4>
        {models.length === 0 ? (
          <p className='text-muted-foreground rounded-md border px-2.5 py-2 text-xs'>
            {t('Nothing was spent through this provider in this period.')}
          </p>
        ) : (
          <div className='space-y-1'>
            {models.map((model) => (
              <ModelLine
                key={model.model}
                model={model}
                total={usage.tokens}
                locale={locale}
              />
            ))}
          </div>
        )}
      </section>

      <section className='space-y-1.5'>
        <h4 className='text-xs font-semibold'>
          {t('Channels')}
          <span className='text-muted-foreground ml-1 font-normal'>
            · {usage.serving}/{channels.length}
          </span>
        </h4>
        {channels.length === 0 ? (
          <p className='text-muted-foreground rounded-md border px-2.5 py-2 text-xs'>
            {t('No channel is registered for this provider yet.')}
          </p>
        ) : (
          <div className='space-y-1'>
            {channels.map((channel) => (
              <ChannelLine key={channel.id} channel={channel} locale={locale} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/** The four numbers a provider's spend comes to, side by side. */
function MetricStrip(props: {
  usage: ProviderUsage
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  const items = [
    {
      icon: Activity,
      label: t('Requests'),
      value: formatNumber(props.usage.requests, props.locale),
      note:
        props.usage.errors > 0
          ? t('{{n}} failed', { n: props.usage.errors })
          : undefined,
      tone: props.usage.errors > 0 ? 'text-destructive' : undefined,
    },
    {
      icon: Coins,
      label: t('Tokens'),
      value: formatCompactNumber(props.usage.tokens, props.locale),
      note: t('{{in}} in · {{out}} out', {
        in: formatCompactNumber(props.usage.prompt_tokens, props.locale),
        out: formatCompactNumber(props.usage.completion_tokens, props.locale),
      }),
    },
    {
      icon: Timer,
      label: t('Average'),
      value: formatUseTime(props.usage.average),
      note: t('per request'),
    },
    {
      icon: Gauge,
      label: t('Channels'),
      value: `${props.usage.serving}/${props.usage.channels.length}`,
      note: t('serving now'),
    },
  ]
  return (
    <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
      {items.map((item) => (
        <div
          key={item.label}
          className='bg-muted/30 rounded-md border px-2.5 py-2'
        >
          <div className='text-muted-foreground flex items-center gap-1 text-[11px] font-medium'>
            <item.icon className='size-3' aria-hidden='true' />
            {item.label}
          </div>
          <div className='mt-1 truncate font-mono text-sm font-semibold tabular-nums'>
            {item.value}
          </div>
          {item.note ? (
            <div
              className={cn(
                'text-muted-foreground mt-0.5 truncate text-[10px]',
                item.tone
              )}
            >
              {item.note}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** One model's share, with the bar that says how much of the spend it is. */
function ModelLine(props: {
  model: UsageModel
  total: number
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  const share = props.total > 0 ? (props.model.tokens / props.total) * 100 : 0
  return (
    <div className='rounded-md border px-2.5 py-1.5'>
      <div className='flex flex-wrap items-baseline gap-1.5'>
        <span className='truncate font-mono text-xs font-medium'>
          {props.model.bare || props.model.model}
        </span>
        {props.model.bare ? (
          <Badge variant='outline' className='font-mono text-[10px]'>
            {props.model.model}
          </Badge>
        ) : null}
        <span className='grow' />
        <span className='text-xs tabular-nums'>
          {formatCompactNumber(props.model.tokens, props.locale)}
          <span className='text-muted-foreground ml-1 text-[10px]'>
            {t('tokens')}
          </span>
        </span>
        <Badge variant='outline' className='text-[10px]'>
          {t('{{n}} req', { n: props.model.requests })}
        </Badge>
        {props.model.average > 0 ? (
          <span className='text-muted-foreground text-[10px]'>
            {formatUseTime(props.model.average)}
          </span>
        ) : null}
      </div>
      <div className='bg-muted mt-1 h-1 w-full overflow-hidden rounded-full'>
        <div
          className='bg-chart-1 h-full rounded-full transition-[width] duration-500'
          style={{ width: `${Math.min(100, share)}` }}
        />
      </div>
      <div className='text-muted-foreground mt-0.5 flex items-center gap-2 text-[10px]'>
        <span>
          {formatCompactNumber(props.model.prompt_tokens, props.locale)} in ·{' '}
          {formatCompactNumber(props.model.completion_tokens, props.locale)} out
        </span>
        <span className='grow' />
        <span>{share.toFixed(1)}%</span>
      </div>
    </div>
  )
}

/** One channel's share: what it serves, whether it is on, what it cost. */
function ChannelLine(props: {
  channel: ProviderUsage['channels'][number]
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-md border px-2.5 py-1.5',
        !props.channel.enabled && 'opacity-60'
      )}
    >
      <span className='text-xs font-medium'>{props.channel.name}</span>
      {props.channel.prefix ? (
        <Badge variant='outline' className='font-mono text-[10px]'>
          {props.channel.prefix}-
        </Badge>
      ) : null}
      <Badge variant='outline' className='text-[10px]'>
        {t('{{n}} model(s)', { n: props.channel.models })}
      </Badge>
      {props.channel.keys ? (
        <Badge variant='secondary' className='text-[10px]'>
          {t('{{n}} key(s)', { n: props.channel.keys })}
        </Badge>
      ) : null}
      <span className='grow' />
      <span className='text-muted-foreground font-mono text-[10px]'>
        p{props.channel.priority} · w{props.channel.weight}
      </span>
      <span className='text-muted-foreground text-[10px] tabular-nums'>
        {formatCompactNumber(props.channel.tokens, props.locale)} {t('tokens')}
      </span>
      <Badge
        variant={props.channel.enabled ? 'secondary' : 'outline'}
        className='text-[10px]'
      >
        {props.channel.enabled ? t('On') : t('Off')}
      </Badge>
    </div>
  )
}
