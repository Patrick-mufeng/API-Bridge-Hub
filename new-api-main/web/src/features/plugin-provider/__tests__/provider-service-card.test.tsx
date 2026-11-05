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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ProviderServiceCard } from '../components/provider-service-card'
import type { PluginProviderOffer } from '../types'

// The card fetches a provider's page once it is opened, so it asks for a
// query client; nothing is opened in these tests unless one says so.
function renderCard(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function makeOffer(
  overrides: Partial<PluginProviderOffer> = {}
): PluginProviderOffer {
  return {
    provider: 'workbuddy',
    name: 'WorkBuddy',
    signed_in: true,
    models: ['glm-5.3', 'hy3', 'auto'],
    accounts: ['workbuddy', 'workbuddy#2apscn'],
    tag: 'plugin:workbuddy:workbuddy',
    ...overrides,
  }
}

// A provider with an account says so, and shows what it has: the operator
// decides whether to open it from these two numbers.
describe('ProviderServiceCard', () => {
  it('shows a signed-in provider with its accounts and models', () => {
    renderCard(<ProviderServiceCard offer={makeOffer()} onSignIn={vi.fn()} />)

    expect(screen.getByText('WorkBuddy')).toBeInTheDocument()
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.getByText(/2 account\(s\), 3 model\(s\)/)).toBeInTheDocument()
  })

  // A provider nothing is signed in to must not look ready: registering it
  // would make channels that all fail.
  it('marks a provider with no account as not signed in', () => {
    renderCard(
      <ProviderServiceCard
        offer={makeOffer({ signed_in: false, accounts: [] })}
        onSignIn={vi.fn()}
      />
    )

    expect(screen.getByText('No account')).toBeInTheDocument()
    expect(screen.getByText(/0 account\(s\), 3 model\(s\)/)).toBeInTheDocument()
  })

  it('asks for a sign-in through its button', async () => {
    const onSignIn = vi.fn()
    renderCard(<ProviderServiceCard offer={makeOffer()} onSignIn={onSignIn} />)

    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }))
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })

  // The row opens in place: what says it is open is aria-expanded, which is
  // what a screen reader and a keyboard user both read.
  it('opens and folds back through the details button', async () => {
    renderCard(<ProviderServiceCard offer={makeOffer()} onSignIn={vi.fn()} />)

    const toggle = screen.getByRole('button', { name: /Details/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    const opened = screen.getByRole('button', { name: /Collapse/i })
    expect(opened).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(opened)
    expect(screen.getByRole('button', { name: /Details/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
