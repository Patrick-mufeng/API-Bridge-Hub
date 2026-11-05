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
import { describe, expect, it } from 'vitest'

import {
  buildTokenTrend,
  buildTokenTrendRows,
  groupTokenStatsByModel,
  sumTokenStats,
} from '../stats'
import type { TokenStatItem } from '../../types'

const row = (overrides: Partial<TokenStatItem>): TokenStatItem => ({
  created_at: 1_700_000_000,
  model_name: 'model-a',
  prompt_tokens: 100,
  completion_tokens: 50,
  token_used: 150,
  count: 1,
  ...overrides,
})

describe('sumTokenStats', () => {
  it('totals every counter across rows', () => {
    const totals = sumTokenStats([
      row({}),
      row({ token_used: 200, prompt_tokens: 150, completion_tokens: 50, count: 2 }),
    ])
    expect(totals.totalTokens).toBe(350)
    expect(totals.promptTokens).toBe(250)
    expect(totals.completionTokens).toBe(100)
    expect(totals.requestCount).toBe(3)
  })

  it('returns zero totals for an empty list', () => {
    expect(sumTokenStats([])).toEqual({
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
    })
  })

  it('treats missing and non-numeric counters as zero instead of NaN', () => {
    const totals = sumTokenStats([
      { created_at: 1 } as TokenStatItem,
      row({ token_used: undefined, prompt_tokens: undefined }),
      row({ prompt_tokens: Number.NaN, token_used: 100 }),
    ])
    expect(totals.totalTokens).toBe(100)
    expect(totals.promptTokens).toBe(0)
    expect(Number.isNaN(totals.totalTokens)).toBe(false)
    expect(Number.isNaN(totals.promptTokens)).toBe(false)
  })
})

describe('groupTokenStatsByModel', () => {
  it('merges hourly rows per model and ranks by total tokens', () => {
    const grouped = groupTokenStatsByModel([
      row({ model_name: 'small', token_used: 10, prompt_tokens: 10, count: 1 }),
      row({ model_name: 'big', token_used: 900, prompt_tokens: 800, count: 3 }),
      row({ model_name: 'small', token_used: 5, prompt_tokens: 5, count: 1 }),
    ])
    expect(grouped.map((entry) => entry.modelName)).toEqual(['big', 'small'])
    expect(grouped[1].totalTokens).toBe(15)
    expect(grouped[1].requestCount).toBe(2)
  })

  it('skips rows without a model name', () => {
    const grouped = groupTokenStatsByModel([
      row({ model_name: '' }),
      row({ model_name: 'kept' }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].modelName).toBe('kept')
  })
})

describe('buildTokenTrendRows', () => {
  it('emits one input and one output row per timestamp, ordered by time', () => {
    const trend = buildTokenTrendRows(
      [
        row({ created_at: 200, prompt_tokens: 5, completion_tokens: 5 }),
        row({ created_at: 100, prompt_tokens: 1, completion_tokens: 2 }),
        row({ created_at: 200, prompt_tokens: 5, completion_tokens: 0 }),
      ],
      'day',
      'Input',
      'Output'
    )
    // 两个时间点 × (输入, 输出) 两条 = 4 行
    expect(trend).toHaveLength(4)
    // 时间升序：较早的时间点排在最前
    expect(trend[0].Kind).toBe('Input')
    expect(trend[0].Tokens).toBe(1)
    expect(trend[1].Kind).toBe('Output')
    expect(trend[1].Tokens).toBe(2)
    // 同一时间戳的两行被合并累加
    expect(trend[2].Tokens).toBe(10)
    expect(trend[3].Tokens).toBe(5)
  })

  it('carries the caller-provided series labels', () => {
    const trend = buildTokenTrendRows([row({})], 'day', '输入', '输出')
    expect(trend.map((entry) => entry.Kind)).toEqual(['输入', '输出'])
  })

  it('returns no rows for an empty input', () => {
    expect(buildTokenTrendRows([])).toEqual([])
  })
})

describe('buildTokenTrend', () => {
  it('totals prompt and completion per timestamp in ascending time order', () => {
    const series = buildTokenTrend([
      row({ created_at: 200, prompt_tokens: 5, completion_tokens: 5 }),
      row({ created_at: 100, prompt_tokens: 1, completion_tokens: 2 }),
      row({ created_at: 200, prompt_tokens: 5, completion_tokens: 0 }),
    ])
    expect(series).toEqual([3, 15])
  })

  it('returns an empty series for no rows', () => {
    expect(buildTokenTrend([])).toEqual([])
  })
})
