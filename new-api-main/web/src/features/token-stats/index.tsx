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
import { Activity, Braces, Coins, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useThemeCustomization } from '@/context/theme-customization-provider'
import { useTheme } from '@/context/theme-provider'
import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber, formatNumber } from '@/lib/format'
import { VCHART_OPTION } from '@/lib/vchart'
import { useAuthStore } from '@/stores/auth-store'

import { getTokenStats } from './api'
import {
  buildTokenTrend,
  buildTokenTrendRows,
  groupTokenStatsByModel,
  sumTokenStats,
} from './lib/stats'
import type { TokenStatItem } from './types'

const DEFAULT_WINDOW_DAYS = 7
const SECONDS_PER_DAY = 86400

let themeManagerPromise: Promise<
  (typeof import('@visactor/vchart'))['ThemeManager']
> | null = null

// 每个模型一行，按总 Token 排序。
// 此表格刻意只呈现 Token：没有任何一列能渲染货币值。
function ModelTokenTable(props: {
  rows: ReturnType<typeof groupTokenStatsByModel>
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  if (props.rows.length === 0) {
    return (
      <p className='text-muted-foreground py-6 text-center text-sm'>
        {t('No token usage in this period')}
      </p>
    )
  }
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-sm'>
        <thead>
          <tr className='text-muted-foreground border-b text-left'>
            <th className='py-2 pr-4 font-medium'>{t('Model')}</th>
            <th className='py-2 pr-4 text-right font-medium'>
              {t('Input Tokens')}
            </th>
            <th className='py-2 pr-4 text-right font-medium'>
              {t('Output Tokens')}
            </th>
            <th className='py-2 pr-4 text-right font-medium'>
              {t('Total Tokens')}
            </th>
            <th className='py-2 text-right font-medium'>{t('Requests')}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.modelName} className='border-b last:border-0'>
              <td className='py-2 pr-4 font-medium break-all'>{row.modelName}</td>
              <td className='py-2 pr-4 text-right tabular-nums'>
                {formatNumber(row.promptTokens, props.locale)}
              </td>
              <td className='py-2 pr-4 text-right tabular-nums'>
                {formatNumber(row.completionTokens, props.locale)}
              </td>
              <td className='py-2 pr-4 text-right font-medium tabular-nums'>
                {formatNumber(row.totalTokens, props.locale)}
              </td>
              <td className='py-2 text-right tabular-nums'>
                {formatNumber(row.requestCount, props.locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Token 用量趋势折线图。沿用站内既有的 VChart 约定：
// 主题经 ThemeManager 切换，spec 交给 VCHART_OPTION 渲染。
function TokenTrendLineChart(props: {
  rows: TokenStatItem[]
  loading: boolean
  error: boolean
}) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const { customization } = useThemeCustomization()
  const [themeReady, setThemeReady] = useState(false)

  const trendRows = useMemo(
    () =>
      props.loading
        ? []
        : buildTokenTrendRows(props.rows, 'day', t('Input'), t('Output')),
    [props.rows, props.loading, t]
  )

  useEffect(() => {
    const updateTheme = async () => {
      setThemeReady(false)
      if (!themeManagerPromise) {
        themeManagerPromise = import('@visactor/vchart').then(
          (m) => m.ThemeManager
        )
      }
      const ThemeManager = await themeManagerPromise
      ThemeManager.setCurrentTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
      setThemeReady(true)
    }
    void updateTheme()
  }, [resolvedTheme])

  const spec = useMemo(() => {
    const formatInt = (value: number) =>
      Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
    return {
      type: 'line',
      data: [{ id: 'tokenTrendData', values: trendRows }],
      xField: 'Time',
      yField: 'Tokens',
      seriesField: 'Kind',
      // 输入/输出两条线各自独立，不堆叠，便于比较走势。
      point: { visible: true, style: { size: 4 } },
      line: { style: { lineWidth: 2 } },
      legends: { visible: true, orient: 'top', position: 'start' },
      padding: { top: 16, right: 24, bottom: 8, left: 8 },
      axes: [
        {
          orient: 'left',
          label: { formatMethod: (v: number) => formatInt(Number(v) || 0) },
        },
        { orient: 'bottom', label: { autoRotate: true } },
      ],
      tooltip: {
        dimension: {
          content: [
            {
              key: (datum: Record<string, unknown>) => datum?.Kind,
              value: (datum: Record<string, unknown>) =>
                formatInt(Number(datum?.Tokens) || 0),
            },
          ],
        },
      },
      background: { fill: 'transparent' },
      animation: true,
    }
  }, [trendRows])

  const chartKey = [
    'token-trend-line',
    props.loading ? 'loading' : 'ready',
    trendRows.length,
    resolvedTheme,
    customization.preset,
  ].join('-')

  if (props.loading) return <Skeleton className='h-72 w-full' />
  if (props.error) {
    return (
      <p className='text-muted-foreground py-6 text-center text-sm'>
        {t('Failed to load token statistics')}
      </p>
    )
  }
  if (trendRows.length === 0) {
    return (
      <p className='text-muted-foreground py-6 text-center text-sm'>
        {t('No token usage in this period')}
      </p>
    )
  }
  if (!themeReady) return <div className='h-72 w-full' />

  return (
    <div className='h-72 w-full'>
      <VChart
        key={chartKey}
        spec={{
          ...spec,
          theme: resolvedTheme === 'dark' ? 'dark' : 'light',
          background: 'transparent',
        }}
        option={VCHART_OPTION}
      />
    </div>
  )
}

export function TokenStats() {
  const { t, i18n } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const isAdmin = !!(user?.role && user.role >= 10)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  const [rows, setRows] = useState<TokenStatItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const abortController = new AbortController()
    const endTimestamp = Math.floor(Date.now() / 1000)
    const startTimestamp = endTimestamp - DEFAULT_WINDOW_DAYS * SECONDS_PER_DAY

    setLoading(true)
    setError(false)
    void getTokenStats({
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
    })
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
        if (!abortController.signal.aborted) setLoading(false)
      })

    return () => abortController.abort()
  }, [reloadKey])

  const totals = useMemo(() => sumTokenStats(rows || []), [rows])
  const modelRows = useMemo(() => groupTokenStatsByModel(rows || []), [rows])
  const sparkline = useMemo(() => buildTokenTrend(rows || []), [rows])

  const formatCount = (value: number) =>
    formatNumber(value, locale).length > 9
      ? formatCompactNumber(value, locale)
      : formatNumber(value, locale)

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex max-w-full min-w-0 items-center gap-2 align-middle'>
          <span className='truncate'>{t('Token Statistics')}</span>
          <Badge variant='outline'>{t('Tokens only')}</Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        {error && !rows ? (
          <ErrorState
            title={t('Failed to load token statistics')}
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        ) : (
          <div className='flex h-full min-h-0 w-full flex-col gap-4'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Token usage only. This page never shows currency amounts, so it keeps working when billing is disabled.'
              )}
            </p>

            {loading ? (
              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className='h-32 w-full' />
                ))}
              </div>
            ) : (
              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                <StatCard
                  title={t('Total Tokens')}
                  value={formatCount(totals.totalTokens)}
                  description={t('Input and output tokens combined')}
                  icon={Braces}
                  sparkline={sparkline}
                  loading={loading}
                  error={error}
                />
                <StatCard
                  title={t('Input Tokens')}
                  value={formatCount(totals.promptTokens)}
                  description={t('Prompt tokens sent upstream')}
                  icon={FileText}
                  loading={loading}
                  error={error}
                />
                <StatCard
                  title={t('Output Tokens')}
                  value={formatCount(totals.completionTokens)}
                  description={t('Tokens generated by the model')}
                  icon={Activity}
                  loading={loading}
                  error={error}
                />
                <StatCard
                  title={t('Requests')}
                  value={formatCount(totals.requestCount)}
                  description={t('Requests recorded in this period')}
                  icon={Coins}
                  loading={loading}
                  error={error}
                />
              </div>
            )}

            <div className='bg-card text-card-foreground rounded-xl border shadow-sm'>
              <div className='border-b px-4 py-3'>
                <h3 className='text-sm font-semibold'>{t('Token Usage Trend')}</h3>
                <p className='text-muted-foreground text-xs'>
                  {t('Input and output tokens per hour')}
                </p>
              </div>
              <div className='p-4'>
                <TokenTrendLineChart
                  rows={rows || []}
                  loading={loading}
                  error={error}
                />
              </div>
            </div>

            <div className='bg-card text-card-foreground rounded-xl border shadow-sm'>
              <div className='border-b px-4 py-3'>
                <h3 className='text-sm font-semibold'>{t('Usage by model')}</h3>
                <p className='text-muted-foreground text-xs'>
                  {isAdmin
                    ? t('Aggregated across every user')
                    : t('Aggregated across your API keys')}
                </p>
              </div>
              <div className='p-4'>
                {loading ? (
                  <Skeleton className='h-32 w-full' />
                ) : (
                  <ModelTokenTable rows={modelRows} locale={locale} />
                )}
              </div>
            </div>
          </div>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
