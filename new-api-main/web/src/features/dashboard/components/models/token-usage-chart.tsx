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
import { VChart } from '@visactor/react-vchart'
import { KeyRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconBadge } from '@/components/ui/icon-badge'
import { useThemeCustomization } from '@/context/theme-customization-provider'
import { useTheme } from '@/context/theme-provider'
import { getFlowQuotaDates } from '@/features/dashboard/api'
import { buildQueryParams, getDefaultDays } from '@/features/dashboard/lib'
import { getDashboardChartColors } from '@/features/dashboard/lib/charts'
import type {
  DashboardFilters,
  FlowQuotaDataItem,
} from '@/features/dashboard/types'
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber, formatNumber } from '@/lib/format'
import { computeTimeRange } from '@/lib/time'
import { useAuthStore } from '@/stores/auth-store'
import { VCHART_OPTION } from '@/lib/vchart'

let themeManagerPromise: Promise<
  (typeof import('@visactor/vchart'))['ThemeManager']
> | null = null

const MAX_TOKEN_KEY_ROWS = 10

interface TokenUsageChartProps {
  filters?: DashboardFilters
}

type TokenKeyRow = {
  Key: string
  Tokens: number
  Count: number
  rawTokens: number
}

function aggregateTokenKeyRows(
  rows: FlowQuotaDataItem[],
  t: (key: string) => string
): TokenKeyRow[] {
  const map = new Map<string, { tokens: number; count: number }>()
  for (const row of rows) {
    const key =
      row.token_name || (row.token_id ? `#${row.token_id}` : t('Unknown'))
    const prev = map.get(key) || { tokens: 0, count: 0 }
    map.set(key, {
      tokens: prev.tokens + (Number(row.token_used) || 0),
      count: prev.count + (Number(row.count) || 0),
    })
  }
  return [...map.entries()]
    .map(([key, stats]) => ({
      Key: key,
      Tokens: stats.tokens,
      Count: stats.count,
      rawTokens: stats.tokens,
    }))
    .sort((a, b) => b.Tokens - a.Tokens)
    .slice(0, MAX_TOKEN_KEY_ROWS)
}

export function TokenUsageChart(props: TokenUsageChartProps) {
  const { t, i18n } = useTranslation()
  const { resolvedTheme } = useTheme()
  const { customization } = useThemeCustomization()
  const user = useAuthStore((state) => state.auth.user)
  const isAdmin = !!(user?.role && user.role >= 10)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  const [rows, setRows] = useState<FlowQuotaDataItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [themeReady, setThemeReady] = useState(false)
  const themeManagerRef = useRef<
    (typeof import('@visactor/vchart'))['ThemeManager'] | null
  >(null)

  useEffect(() => {
    const abortController = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(false)

    const timeRange = computeTimeRange(
      getDefaultDays(props.filters?.time_granularity),
      props.filters?.start_timestamp,
      props.filters?.end_timestamp
    )

    void getFlowQuotaDates(
      buildQueryParams(timeRange, props.filters),
      isAdmin
    )
      .then((res) => {
        if (abortController.signal.aborted) return
        setRows(res?.data || [])
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setRows(null)
        setError(true)
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setLoading(false)
        }
      })

    return () => {
      abortController.abort()
    }
  }, [props.filters, isAdmin])

  useEffect(() => {
    const updateTheme = async () => {
      setThemeReady(false)

      if (!themeManagerPromise) {
        themeManagerPromise = import('@visactor/vchart').then(
          (m) => m.ThemeManager
        )
      }

      const ThemeManager = await themeManagerPromise
      themeManagerRef.current = ThemeManager
      ThemeManager.setCurrentTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
      setThemeReady(true)
    }

    updateTheme()
  }, [resolvedTheme])

  const chartRows = useMemo(
    () => (loading ? [] : aggregateTokenKeyRows(rows || [], t)),
    [rows, loading, t]
  )
  const totalTokens = useMemo(
    () => (rows || []).reduce((sum, row) => sum + (Number(row.token_used) || 0), 0),
    [rows]
  )

  const spec = useMemo(() => {
    const colorRange = getDashboardChartColors(chartRows.length || 1)
    const formatInt = (value: number) =>
      Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
    return {
      type: 'bar',
      data: [{ id: 'tokenKeyData', values: chartRows }],
      xField: 'Tokens',
      yField: 'Key',
      seriesField: 'Key',
      direction: 'horizontal',
      legends: { visible: false },
      color: { type: 'ordinal', range: colorRange },
      label: {
        visible: true,
        position: 'outside',
        formatMethod: (value: number) => formatInt(Number(value) || 0),
        style: { fontSize: 11 },
      },
      axes: [
        { orient: 'left', type: 'band' },
        { orient: 'bottom', type: 'linear', visible: false },
      ],
      bar: {
        state: { hover: { stroke: '#000', lineWidth: 1 } },
      },
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: Record<string, unknown>) => datum?.Key,
              value: (datum: Record<string, unknown>) =>
                `${formatInt(Number(datum?.Tokens) || 0)} · ${formatInt(
                  Number(datum?.Count) || 0
                )} ${t('Requests')}`,
            },
          ],
        },
      },
      background: { fill: 'transparent' },
      animation: true,
    }
  }, [chartRows, t])

  const totalDisplay =
    formatNumber(totalTokens, locale).length > 9
      ? formatCompactNumber(totalTokens, locale)
      : formatNumber(totalTokens, locale)

  const specType = typeof spec.type === 'string' ? spec.type : 'bar'
  const chartKey = [
    specType,
    loading ? 'loading' : 'ready',
    chartRows.length,
    resolvedTheme,
    customization.preset,
  ].join('-')

  return (
    <div className='overflow-hidden rounded-lg border'>
      <div className='flex w-full flex-col gap-1.5 border-b px-3 py-2 sm:gap-3 sm:px-5 sm:py-3 lg:flex-row lg:items-center lg:justify-between'>
        <div className='flex items-center gap-2'>
          <IconBadge tone='chart-2' size='sm'>
            <KeyRound />
          </IconBadge>
          <div className='text-sm font-semibold'>
            {t('Token Usage by API Key')}
          </div>
          <span className='text-muted-foreground text-xs'>
            {t('Total:')} {totalDisplay}
          </span>
        </div>
      </div>

      <div className='h-[300px] p-1.5 sm:h-96 sm:p-2'>
        {loading ? null : error ? (
          <div
            className={cn(
              'text-muted-foreground flex h-full items-center justify-center text-sm'
            )}
          >
            {t('Failed to load token usage data')}
          </div>
        ) : chartRows.length === 0 ? (
          <div className='text-muted-foreground flex h-full items-center justify-center text-sm'>
            {t('No token usage data')}
          </div>
        ) : themeReady ? (
          <VChart
            key={chartKey}
            spec={{
              ...spec,
              theme: resolvedTheme === 'dark' ? 'dark' : 'light',
              background: 'transparent',
            }}
            option={VCHART_OPTION}
          />
        ) : null}
      </div>
    </div>
  )
}
