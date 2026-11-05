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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber } from '@/lib/format'

import type { UsageWindow } from '../types'

/**
 * A provider's spend over the period, drawn as two stacked series: the
 * tokens it read and the tokens it wrote. A quiet bucket is a zero in the
 * line rather than a gap, because the server lays every bucket of the period
 * out whether anything was spent in it or not.
 */
export function UsageTrendChart(props: {
  trend: UsageWindow[]
  granularity: 'hour' | 'day'
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  const config = useMemo<ChartConfig>(
    () => ({
      prompt: { label: t('Input Tokens'), color: 'var(--chart-1)' },
      completion: { label: t('Output Tokens'), color: 'var(--chart-2)' },
    }),
    [t]
  )

  // the buckets are stamped in the server's zone; the reader's own zone is
  // what the axis should say, so each is formatted here
  const rows = useMemo(
    () =>
      props.trend.map((window) => {
        const at = new Date(window.start * 1000)
        const label =
          props.granularity === 'hour'
            ? at.toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
              })
            : at.toLocaleDateString(locale, {
                month: 'short',
                day: 'numeric',
              })
        return {
          label,
          prompt: window.prompt_tokens,
          completion: window.completion_tokens,
          requests: window.requests,
        }
      }),
    [props.trend, props.granularity, locale]
  )

  if (rows.length === 0) {
    return (
      <p className='text-muted-foreground py-8 text-center text-xs'>
        {t('No data')}
      </p>
    )
  }

  return (
    <ChartContainer config={config} className='aspect-auto h-48 w-full'>
      <AreaChart data={rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray='3 3' />
        <XAxis
          dataKey='label'
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={18}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(value: number) => formatCompactNumber(value, locale)}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator='dot' />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey='completion'
          type='monotone'
          stackId='tokens'
          fill='var(--color-completion)'
          stroke='var(--color-completion)'
          fillOpacity={0.28}
          strokeWidth={2}
        />
        <Area
          dataKey='prompt'
          type='monotone'
          stackId='tokens'
          fill='var(--color-prompt)'
          stroke='var(--color-prompt)'
          fillOpacity={0.28}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
