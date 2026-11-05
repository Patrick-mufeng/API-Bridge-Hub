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

import { AccountRow } from '../components/account-row'
import type { PluginAccount } from '../types'

function renderRow(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function account(overrides: Partial<PluginAccount> = {}): PluginAccount {
  return {
    key: 'workbuddy#2apscn',
    label: '2apscn',
    type: 'oauth',
    key_index: 1,
    ...overrides,
  }
}

// One account is a thing an operator acts on, not just a number: it can be
// checked in, signed in again, or taken out — and taking it out has to be
// reachable from the row itself, which is where the account is.
describe('AccountRow', () => {
  it('offers removing an account it was given a handler for', async () => {
    const onSignOut = vi.fn()
    renderRow(<AccountRow account={account()} onSignOut={onSignOut} />)

    const remove = screen.getByRole('button', { name: /Remove/i })
    expect(remove).toBeInTheDocument()
    await userEvent.click(remove)
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  // A row shown for reading only — an account list in a summary — must not
  // offer an action the caller gave no handler for.
  it('offers no remove button without a handler', () => {
    renderRow(<AccountRow account={account()} />)
    expect(
      screen.queryByRole('button', { name: /Remove/i })
    ).not.toBeInTheDocument()
  })

  // An account whose sign-in lapsed is the one an operator most often wants
  // to replace, so both actions are there and both name what they do.
  it('offers checking in, signing in again and removing side by side', () => {
    renderRow(
      <AccountRow
        account={account({ needs_sign_in: true })}
        onCheckin={vi.fn()}
        onSignIn={vi.fn()}
        onSignOut={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: /Check in/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Sign in again/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument()
  })

  // Trae CN reports credits as an amount against a limit and sends no
  // wording of its own. Drawn as a percentage alone, the row said "3%" and
  // answered neither how much was used nor how much there was.
  it('shows the figures a vendor reports, not only the percentage', () => {
    renderRow(
      <AccountRow
        account={account({
          plan: 'Credits',
          windows: [
            {
              name: 'Credits',
              used: 2.9779199999999997,
              amount: 29.78,
              limit: 1000,
              unit: 'credits',
            },
          ],
        })}
      />
    )
    expect(screen.getByText('29.78 / 1000 credits · 3%')).toBeInTheDocument()
  })

  // A plugin that sends its own wording knows its vendor's units better
  // than the console does, so it is taken at its word.
  it('keeps the plugin’s own wording when it sends one', () => {
    renderRow(
      <AccountRow
        account={account({
          windows: [
            {
              name: 'Credits',
              used: 50,
              amount: 5,
              limit: 10,
              display: '5 of 10',
            },
          ],
        })}
      />
    )
    expect(screen.getByText('5 of 10')).toBeInTheDocument()
  })

  // A vendor that reports only a percentage is still drawn, as before.
  it('falls back to the percentage when no figures are given', () => {
    renderRow(
      <AccountRow
        account={account({ windows: [{ name: 'Weekly', used: 42 }] })}
      />
    )
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  // WorkBuddy's "0 / 500" window sends the share and the size but no
  // amount: the figure is worked back so the row still says 0 of 500,
  // not a bare "0%" that hides what the 500 is.
  it('works the amount back when a plugin sends only the share and size', () => {
    renderRow(
      <AccountRow
        account={account({
          windows: [
            { name: 'Credits', used: 0, limit: 500, unit: 'credits' },
            { name: 'Extra credits', used: 5.79, limit: 3712, unit: 'credits' },
          ],
        })}
      />
    )
    expect(screen.getByText('0 / 500 credits · 0%')).toBeInTheDocument()
    // 5.79% of 3712 credits, worked back from the share the plugin sent
    expect(screen.getByText('214.92 / 3712 credits · 6%')).toBeInTheDocument()
  })
})
