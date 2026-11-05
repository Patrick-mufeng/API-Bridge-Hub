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
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ModelTable } from '../components/model-table'
import type { PluginModel } from '../types'

function model(overrides: Partial<PluginModel> = {}): PluginModel {
  return {
    id: 'glm-5.3',
    relay_name: 'workbuddy-glm-5.3',
    context: 1_000_000,
    output: 64_000,
    ...overrides,
  }
}

describe('ModelTable', () => {
  it('shows the name a client asks for, not the vendor id', () => {
    render(<ModelTable models={[model()]} />)
    expect(screen.getByText('workbuddy-glm-5.3')).toBeInTheDocument()
  })

  // The thinking depths are names a client can ask for, so they belong next
  // to the model rather than in a tooltip.
  it('lists the thinking depths a model takes', () => {
    render(<ModelTable models={[model({ variants: ['low', 'high'] })]} />)
    expect(screen.getByText('low')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
  })

  // A model offered at one depth only is still a fact, and an empty cell
  // says nothing.
  it('says none where a model takes no thinking depth', () => {
    render(<ModelTable models={[model({ variants: [] })]} />)
    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('shows the credits a model costs and what they were cut from', () => {
    render(<ModelTable models={[model({ rate: 0.2, rate_was: 0.4 })]} />)
    expect(screen.getByText(/x0\.2/)).toBeInTheDocument()
    expect(screen.getByText(/x0\.4/)).toBeInTheDocument()
  })

  it('does not print a price for a model that costs nothing', () => {
    render(<ModelTable models={[model({ free: true })]} />)
    expect(screen.getByText('x0')).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
  })

  // A value the plugin never stated is not zero: a blank cell says "nobody
  // said", where a nought would say the model holds nothing.
  it('leaves a limit the plugin did not state blank', () => {
    render(
      <ModelTable models={[model({ context: undefined, output: undefined })]} />
    )
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('finds a model by its relay name', async () => {
    render(
      <ModelTable
        models={[model(), model({ id: 'hy3', relay_name: 'workbuddy-hy3' })]}
      />
    )
    await userEvent.type(screen.getByLabelText('Search models'), 'hy3')
    expect(screen.getByText('workbuddy-hy3')).toBeInTheDocument()
    expect(screen.queryByText('workbuddy-glm-5.3')).not.toBeInTheDocument()
  })
})
