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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Plug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  getPluginProvider,
  listPluginProviders,
  syncPluginHealth,
} from '../api'
import type { PluginMethod, PluginProviderOffer } from '../types'
import { CheckinCard } from './checkin-card'
import { ProviderServiceCard } from './provider-service-card'
import { SignInDialog } from './signin-dialog'

/**
 * The providers the installed plugins serve, one row each, opening in place.
 *
 * A row that opens carries the provider's whole page: its accounts with
 * their allowances, the plugin's own switches, and what the relay spent
 * through it. The row itself stays scannable, which is what an operator
 * with six subscriptions needs before opening any of them.
 */
export function ProvidersPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [signInTarget, setSignInTarget] = useState<PluginProviderOffer | null>(
    null
  )
  const [methods, setMethods] = useState<PluginMethod[]>([])

  const healthMutation = useMutation({
    mutationFn: async () => requireServerSuccess(await syncPluginHealth()),
    onSuccess: (res) => {
      toast.success(
        t('Account health checked: {{summary}}', {
          summary: res.data?.summary || t('done'),
        })
      )
      void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })
    },
    onError: (error) => handleServerError(error),
  })

  const providersQuery = useQuery({
    queryKey: ['plugin-provider', 'providers'],
    queryFn: async () => requireServerSuccess(await listPluginProviders()).data,
    retry: false,
  })

  // the sign-in methods come with the provider's detail, which means a
  // round trip: fetched when the dialog opens, not for every row
  const openSignIn = (offer: PluginProviderOffer) => {
    setSignInTarget(offer)
    setMethods([])
    void getPluginProvider(offer.provider)
      .then((res) => {
        const data = requireServerSuccess(res).data
        setMethods(data?.methods ?? [])
      })
      .catch(() => setMethods([]))
  }

  if (providersQuery.isLoading) {
    return <LoadingState message={t('Loading plugin providers…')} />
  }
  if (providersQuery.isError || !providersQuery.data) {
    return (
      <ErrorState
        title={t('We could not load plugin providers.')}
        description={
          providersQuery.error instanceof Error
            ? providersQuery.error.message
            : undefined
        }
        onRetry={() => void providersQuery.refetch()}
      />
    )
  }

  const offers = providersQuery.data.providers ?? []

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
            <Plug className='size-4' aria-hidden='true' />
          </span>
          <div className='min-w-0'>
            <h3 className='text-sm font-semibold'>{t('Providers')}</h3>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              {t(
                'Open a provider to see its accounts and allowance, what the relay spent through it, and the switches its plugin declares.'
              )}
            </p>
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <Badge variant='outline'>
            {t('{{count}} provider(s)', { count: offers.length })}
          </Badge>
          <Button
            variant='outline'
            size='sm'
            onClick={() => healthMutation.mutate()}
            disabled={healthMutation.isPending}
          >
            <Activity data-icon='inline-start' aria-hidden='true' />
            {t('Check accounts')}
          </Button>
        </div>
      </div>

      <CheckinCard />

      {offers.length === 0 ? (
        <EmptyState
          title={t('No plugin provider yet.')}
          description={t(
            'Install a provider plugin on the Plugins tab, then sign an account in.'
          )}
        />
      ) : (
        <div className='space-y-2'>
          {offers.map((offer) => (
            <ProviderServiceCard
              key={offer.provider}
              offer={offer}
              onSignIn={() => openSignIn(offer)}
            />
          ))}
        </div>
      )}

      {signInTarget ? (
        <SignInDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setSignInTarget(null)
            }
          }}
          provider={signInTarget.provider}
          providerName={signInTarget.name}
          methods={methods}
        />
      ) : null}
    </div>
  )
}
