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
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { RichContent } from '@/components/rich-content'
import { Skeleton } from '@/components/ui/skeleton'
import { isHttpUrl, isLikelyHtml } from '@/lib/content-format'
import { useStatus } from '@/hooks/use-status'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getAboutContent } from './api'

function AboutContent() {
  const { t } = useTranslation()
  const { status } = useStatus()
  const serverAddress = (
    (status?.server_address as string | undefined) || window.location.origin
  ).replace(/\/+$/, '')

  const features = [
    {
      title: t('Unified endpoint'),
      description: t(
        'OpenAI-compatible /v1 — works with common clients out of the box.'
      ),
    },
    {
      title: t('Per-channel prefixes'),
      description: t(
        'wb:, qd:, cl:, ocz:, tr:, cg: — pick the exact upstream you want.'
      ),
    },
    {
      title: t('Token analytics'),
      description: t(
        'The dashboard tracks token usage per model and per key.'
      ),
    },
    {
      title: t('Admin-issued accounts'),
      description: t(
        'Accounts and quota are managed by the administrator.'
      ),
    },
  ]

  return (
    <div className='flex min-h-[60vh] items-center justify-center p-8'>
      <div className='max-w-2xl space-y-8'>
        <div className='space-y-3 text-center'>
          <h2 className='text-3xl font-bold'>{t('About BridgeHub')}</h2>
          <p className='text-muted-foreground mx-auto max-w-xl text-sm leading-relaxed'>
            {t(
              'BridgeHub is a personal AI API relay: multiple upstream model channels are aggregated behind one OpenAI-compatible endpoint, with per-channel model prefixes so you always know which upstream serves a request.'
            )}
          </p>
        </div>

        <div className='grid gap-3 sm:grid-cols-2'>
          {features.map((feature) => (
            <div key={feature.title} className='rounded-xl border p-4'>
              <div className='text-sm font-semibold'>{feature.title}</div>
              <p className='text-muted-foreground mt-1.5 text-xs leading-relaxed'>
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        <div className='rounded-xl border p-4'>
          <div className='text-sm font-semibold'>{t('Getting started')}</div>
          <p className='text-muted-foreground mt-1.5 text-xs leading-relaxed'>
            {t(
              'Ask the administrator for an account, create a key under API Keys, then point your client at {{address}}/v1. The API Keys page has a full connection guide.',
              { address: serverAddress }
            )}
          </p>
        </div>

        <p className='text-muted-foreground/70 text-center text-xs'>
          {t('Based on the open source project')}{' '}
          <a
            href='https://github.com/QuantumNous/new-api'
            target='_blank'
            rel='noopener noreferrer'
            className='text-primary hover:underline'
          >
            New API
          </a>{' '}
          {t('(AGPL v3.0). Thanks to QuantumNous and One API.')}
        </p>
      </div>
    </div>
  )
}

export function About() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['about-content'],
    queryFn: async () => requireServerSuccess(await getAboutContent()),
  })

  const rawContent = data?.data?.trim() ?? ''
  const hasContent = rawContent.length > 0
  const isUrl = hasContent && isHttpUrl(rawContent)
  const contentIsHtml = hasContent && isLikelyHtml(rawContent)

  if (isLoading) {
    return (
      <PublicLayout>
        <div className='mx-auto flex max-w-4xl flex-col gap-4 py-12'>
          <Skeleton className='h-8 w-[45%]' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-[90%]' />
          <Skeleton className='h-4 w-[80%]' />
        </div>
      </PublicLayout>
    )
  }

  if (!hasContent) {
    return (
      <PublicLayout>
        <AboutContent />
      </PublicLayout>
    )
  }

  if (isUrl) {
    return (
      <PublicLayout showMainContainer={false}>
        <iframe
          src={rawContent}
          className='h-[calc(100vh-3.5rem)] w-full border-0'
          title={t('About')}
          sandbox='allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts'
        />
      </PublicLayout>
    )
  }

  if (contentIsHtml) {
    return (
      <PublicLayout showMainContainer={false}>
        <RichContent
          mode='html'
          htmlVariant='isolated'
          content={rawContent}
          className='prose-neutral dark:prose-invert max-w-none'
        />
      </PublicLayout>
    )
  }

  return (
    <PublicLayout>
      <div className='mx-auto max-w-6xl px-4 py-8'>
        <RichContent
          mode='markdown'
          content={rawContent}
          className='prose-neutral dark:prose-invert max-w-none'
        />
      </div>
    </PublicLayout>
  )
}
