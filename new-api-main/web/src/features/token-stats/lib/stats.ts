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
import { formatChartTime, type TimeGranularity } from '@/lib/time'

import type {
  TokenStatItem,
  TokenStatsModelRow,
  TokenStatsTotals,
} from '../types'

const numberValue = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// 历史行可能缺少计数字段，因此每个字段都回退为 0，避免汇总出现 NaN。
export function sumTokenStats(rows: TokenStatItem[]): TokenStatsTotals {
  return rows.reduce<TokenStatsTotals>(
    (totals, row) => {
      return {
        totalTokens: totals.totalTokens + numberValue(row.token_used),
        promptTokens: totals.promptTokens + numberValue(row.prompt_tokens),
        completionTokens:
          totals.completionTokens + numberValue(row.completion_tokens),
        requestCount: totals.requestCount + numberValue(row.count),
      }
    },
    {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
    }
  )
}

// 跨所有小时桶按模型聚合，并按总 Token 排序。
export function groupTokenStatsByModel(
  rows: TokenStatItem[]
): TokenStatsModelRow[] {
  const map = new Map<string, TokenStatsModelRow>()
  for (const row of rows) {
    const modelName = row.model_name || ''
    if (!modelName) continue
    const existing = map.get(modelName) ?? {
      modelName,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
    }
    existing.totalTokens += numberValue(row.token_used)
    existing.promptTokens += numberValue(row.prompt_tokens)
    existing.completionTokens += numberValue(row.completion_tokens)
    existing.requestCount += numberValue(row.count)
    map.set(modelName, existing)
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

// VChart 折线图使用的长表行：每个时间点按 Kind 拆成「输入」「输出」两条。
export type TokenTrendRow = {
  Time: string
  Kind: string
  Tokens: number
}

// 把按小时的行整理为折线图长表：先按时间升序，
// 再在每个时间点输出输入/输出两条，时间标签复用站内 formatChartTime。
export function buildTokenTrendRows(
  rows: TokenStatItem[],
  granularity: TimeGranularity = 'day',
  inputLabel = 'Input',
  outputLabel = 'Output'
): TokenTrendRow[] {
  const buckets = new Map<number, { input: number; output: number }>()
  for (const row of rows) {
    const createdAt = numberValue(row.created_at)
    const bucket = buckets.get(createdAt) ?? { input: 0, output: 0 }
    bucket.input += numberValue(row.prompt_tokens)
    bucket.output += numberValue(row.completion_tokens)
    buckets.set(createdAt, bucket)
  }

  const trend: TokenTrendRow[] = []
  for (const [createdAt, bucket] of [...buckets.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    const time = formatChartTime(createdAt, granularity)
    trend.push({ Time: time, Kind: inputLabel, Tokens: bucket.input })
    trend.push({ Time: time, Kind: outputLabel, Tokens: bucket.output })
  }
  return trend
}

// 折线图下方迷你趋势条使用的总量序列，按时间升序。
export function buildTokenTrend(rows: TokenStatItem[]): number[] {
  const buckets = new Map<number, number>()
  for (const row of rows) {
    const createdAt = numberValue(row.created_at)
    const total = numberValue(row.prompt_tokens) + numberValue(row.completion_tokens)
    buckets.set(createdAt, (buckets.get(createdAt) ?? 0) + total)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}
