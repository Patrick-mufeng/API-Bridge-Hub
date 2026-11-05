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
import { useQuery } from '@tanstack/react-query'
import { Plug, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getPluginProvider, listPluginProviders } from './api'
import { ProviderServiceCard } from './components/provider-service-card'
import { SignInDialog } from './components/signin-dialog'
import type { PluginMethod, PluginProviderOffer } from './types'

/**

import { useQuery } from '@tanstack/react-query'
import { Plug, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getPluginProvider, listPluginProviders } from './api'
import type { PluginMethod, PluginProviderOffer } from './types'
import { ProviderServiceCard } from './components/provider-service-card'
import { SignInDialog } from './components/signin-dialog'

/**
 * Services: one page for what this relay actually serves.
 *
 * The Plugins page is about packages — what is installed, what the market
 * offers, what is out of date. This one is about the subscriptions those
 * packages sign in to: each row opens in place onto its accounts and their
 * allowance, what was spent through it, and the switches its plugin
 * declares. An operator with several accounts across several vendors works
 * here, not there.
 */
export function ServicesPage() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [signInTarget, setSignInTarget] = useState<PluginProviderOffer | null>(
    null
  )
  const [methods, setMethods] = useState<PluginMethod[]>([])

  const providersQuery = useQuery({
    queryKey: ['plugin-provider', 'providers'],
    queryFn: async () => requireServerSuccess(await listPluginProviders()).data,
    retry: false,
  })

  const offers = useMemo(
    () => providersQuery.data?.providers ?? [],
    [providersQuery.data]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return offers
    }
    return offers.filter((offer) =>
      [offer.name, offer.provider, ...(offer.models ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [offers, query])

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

  const signedIn = offers.filter((offer) => offer.signed_in).length

  let body = null
  if (providersQuery.isLoading) {
    body = <LoadingState message={t('Loading services…')} />
  } else if (providersQuery.isError) {
    body = (
      <ErrorState
        title={t('We could not load the services.')}
        description={
          providersQuery.error instanceof Error
            ? providersQuery.error.message
            : undefined
        }
        onRetry={() => void providersQuery.refetch()}
      />
    )
  } else {
    body = (
      <ServicesBody
        offers={offers}
        shown={shown}
        signedIn={signedIn}
        query={query}
        onQuery={setQuery}
        onSignIn={openSignIn}
      />
    )
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex min-w-0 items-center gap-2'>
          <span className='truncate'>{t('Services')}</span>
          <Badge variant='outline' className='shrink-0'>
            {t('Admin')}
          </Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        {body}
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
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

/** The list itself: what is served, and the search that narrows it. */
function ServicesBody(props: {
  offers: PluginProviderOffer[]
  shown: PluginProviderOffer[]
  signedIn: number
  query: string
  onQuery: (value: string) => void
  onSignIn: (offer: PluginProviderOffer) => void
}) {
  const { t } = useTranslation()

  let list = null
  if (props.offers.length === 0) {
    list = (
      <EmptyState
        title={t('No plugin provider yet.')}
        description={t(
          'Install a provider plugin on the Plugins page, then sign an account in.'
        )}
      />
    )
  } else if (props.shown.length === 0) {
    list = (
      <EmptyState
        title={t('Nothing matches.')}
        description={t('Clear the search to see every service.')}
      />
    )
  } else {
    list = (
      <div className='space-y-2'>
        {props.shown.map((offer) => (
          <ProviderServiceCard
            key={offer.provider}
            offer={offer}
            onSignIn={() => props.onSignIn(offer)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
          <Plug className='size-4' aria-hidden='true' />
        </span>
        <div className='min-w-0 flex-1'>
          <h3 className='text-sm font-semibold'>{t('Services')}</h3>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t(
              'Each subscription this relay serves: its accounts and their allowance, what was spent through it, and the switches its plugin declares.'
            )}
          </p>
        </div>
        <Badge variant='outline'>
          {t('{{signed}} of {{total}} signed in', {
            signed: props.signedIn,
            total: props.offers.length,
          })}
        </Badge>
      </div>

      {props.offers.length > 0 ? (
        <div className='relative max-w-sm'>
          <Search
            className='text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2'
            aria-hidden='true'
          />
          <Input
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
            placeholder={t('Search services and models')}
            aria-label={t('Search services')}
            className='h-8 pl-7 text-xs'
          />
        </div>
      ) : null}

      {list}
    </div>
  )
}
