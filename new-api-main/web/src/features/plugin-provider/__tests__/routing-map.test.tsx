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
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RoutingRow } from '../components/routing-map'
import { groupRoutes } from '../lib/routes'
import type { BareRouteMember } from '../types'

function member(overrides: Partial<BareRouteMember> = {}): BareRouteMember {
  return {
    channel_id: 1,
    name: 'WorkBuddy',
    priority: 0,
    weight: 0,
    enabled: true,
    ...overrides,
  }
}

function renderRow(names: string[], members: BareRouteMember[]) {
  const [group] = groupRoutes(
    Object.fromEntries(names.map((n) => [n, members]))
  )
  return render(<RoutingRow group={group} index={0} />)
}

// Names that reach the same providers in the same order are one fact: drawn
// a row each, a hub serving one subscription is seventeen identical rows.
describe('groupRoutes', () => {
  it('puts names reaching the same providers in one row', () => {
    const groups = groupRoutes({
      'glm-5.3': [member()],
      hy3: [member()],
      auto: [member()],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].names).toEqual(['auto', 'glm-5.3', 'hy3'])
  })

  // Two channels at the same priority are alternatives, not a sequence: the
  // relay picks between them at random, so which one is listed first is not a
  // fact worth a separate row.
  it('treats members of one tier as the same fact whatever their order', () => {
    const wb = member({ channel_id: 1, name: 'WorkBuddy', rank: 0 })
    const qd = member({ channel_id: 2, name: 'Qoder', rank: 0 })
    const groups = groupRoutes({
      'glm-5.3': [wb, qd],
      hy3: [qd, wb],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].names).toEqual(['glm-5.3', 'hy3'])
  })

  // A fallback really is a second tier, so it is a different fact.
  it('keeps a fallback tier apart', () => {
    const primary = member({ channel_id: 1, name: 'WorkBuddy', rank: 0 })
    const fallback = member({ channel_id: 2, name: 'Qoder', rank: 1 })
    const groups = groupRoutes({
      'glm-5.3': [primary, fallback],
      hy3: [primary],
    })
    expect(groups).toHaveLength(2)
  })

  it('orders the rows by how many names they serve', () => {
    const groups = groupRoutes({
      a: [member({ channel_id: 1 })],
      b: [member({ channel_id: 2 })],
      c: [member({ channel_id: 2 })],
    })
    expect(groups[0].names).toEqual(['b', 'c'])
    expect(groups[1].names).toEqual(['a'])
  })
})

describe('RoutingRow', () => {
  it('says how many names a row stands for', () => {
    renderRow(['glm-5.3', 'hy3', 'auto'], [member()])
    expect(screen.getByText('3 model names')).toBeInTheDocument()
    // the preview lists them in the order the names are sorted, which is
    // the order the whole row is built in
    expect(screen.getByText(/auto, glm-5\.3, hy3/)).toBeInTheDocument()
  })

  // One provider needs no ordering marks: there is nothing after it, so
  // "first" and a priority would both be noise.
  it('draws a single provider without an order mark', () => {
    renderRow(['hy3'], [member()])
    expect(screen.getByText('hy3')).toBeInTheDocument()
    expect(screen.getByText('WorkBuddy')).toBeInTheDocument()
    expect(screen.queryByText('first')).not.toBeInTheDocument()
  })

  // A name nobody serves cannot be reached, and the row says so rather than
  // looking like a working route.
  it('says so when nobody is serving a name', () => {
    renderRow(['hy3'], [member({ enabled: false })])
    expect(screen.getByText('Nobody serving it')).toBeInTheDocument()
  })
})
