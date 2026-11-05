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
import { api } from '@/lib/api'

import type { TokenStatItem } from './types'

// 纯 Token 用量数据。所有已登录用户均可访问；
// 管理员得到全部用户的数据，并可用 username 缩小查询范围。
export async function getTokenStats(params: {
  start_timestamp: number
  end_timestamp: number
  username?: string
}) {
  const res = await api.get<{ success: boolean; data: TokenStatItem[] }>(
    '/api/data/tokens',
    { params }
  )
  return res.data
}
