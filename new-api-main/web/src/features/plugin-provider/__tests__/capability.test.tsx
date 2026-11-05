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

import { NotProvided } from '../components/not-provided'
import { UsagePanel } from '../components/usage-panel'

// A plugin is written to a contract that lets it declare what it can do. One
// that declares no usage hook has nothing to report — and a page that draws an
// empty chart instead says "still loading" or "broken", which are both wrong.
describe('a capability the plugin did not declare', () => {
  it('says the plugin does not provide it, and names the hook', () => {
    render(<NotProvided what='Usage' hook='auth.usage' />)
    expect(screen.getByText('Usage')).toBeInTheDocument()
    expect(
      screen.getByText('This plugin does not provide it')
    ).toBeInTheDocument()
    expect(screen.getByText('auth.usage')).toBeInTheDocument()
  })

  // usage is drawn from the plugin's own allowance report: without the hook
  // there is nothing to draw, so the panel says so rather than querying
  it('draws nothing for usage when the plugin declares none', () => {
    render(<UsagePanel provider='workbuddy' offered={false} />)
    expect(screen.getByText('Usage')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This plugin reports no allowance, so there is no usage to draw.'
      )
    ).toBeInTheDocument()
  })

  // what the relay itself counted is still true, and is not the plugin's news
  it('points at the relay’s own records for what it did relay', () => {
    render(<UsagePanel provider='workbuddy' offered={false} />)
    expect(screen.getByText(/on the Routing page/)).toBeInTheDocument()
  })
})
