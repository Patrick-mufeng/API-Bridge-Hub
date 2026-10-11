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
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Copy, Terminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useStatus } from '@/hooks/use-status'
import { getUserModels } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

// The reverse-proxy services behind this relay. Keep in sync with
// data/reverse-proxy/services/*.json manifests.
const RELAY_CHANNELS = [
  { name: 'WorkBuddy', prefix: 'wb:' },
  { name: 'Qoder', prefix: 'qd:' },
  { name: 'Cline', prefix: 'cl:' },
  { name: 'OpenCodeZ', prefix: 'ocz:' },
  { name: 'Trae', prefix: 'tr:' },
  { name: 'CmdGo', prefix: 'cg:' },
]

function CardShell({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'bg-card text-card-foreground relative overflow-hidden rounded-xl border shadow-sm',
        className
      )}
    >
      {children}
    </div>
  )
}

function EndpointTerminal() {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { copyToClipboard } = useCopyToClipboard()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)
  const [copied, setCopied] = useState(false)

  const modelsQuery = useQuery({
    queryKey: ['home', 'user-models'],
    queryFn: async () => requireServerSuccess(await getUserModels()),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const exampleModel = modelsQuery.data?.data?.[0] ?? 'your-model'

  const serverAddress = (
    (status?.server_address as string | undefined) || window.location.origin
  ).replace(/\/+$/, '')
  const baseUrl = `${serverAddress}/v1`

  const curlExample = [
    `curl ${baseUrl}/chat/completions \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer ${t('sk-your-api-key')}" \\`,
    `  -d '{"model":"${exampleModel}","messages":[{"role":"user","content":"${t('Hello')}"}]}'`,
  ].join('\n')

  const handleCopy = async () => {
    const ok = await copyToClipboard(curlExample)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <CardShell className='bg-zinc-950 md:col-span-2 md:row-span-2'>
      {/* subtle gradient glow */}
      <div
        aria-hidden
        className='pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl'
      />
      <div className='flex items-center gap-2 border-b border-zinc-800 px-4 py-3'>
        <span className='size-2.5 rounded-full bg-red-500/80' />
        <span className='size-2.5 rounded-full bg-amber-500/80' />
        <span className='size-2.5 rounded-full bg-emerald-500/80' />
        <span className='text-zinc-400 ml-2 flex items-center gap-1.5 font-mono text-xs'>
          <Terminal className='size-3.5' />
          bridgehub — curl
        </span>
        <button
          type='button'
          onClick={() => void handleCopy()}
          className='text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors'
        >
          {copied ? (
            <Check className='size-3.5' />
          ) : (
            <Copy className='size-3.5' />
          )}
          {copied ? t('Copied') : t('Copy example')}
        </button>
      </div>
      <div className='p-4 sm:p-5'>
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <span className='rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-400'>
            POST
          </span>
          <span className='text-zinc-300 font-mono text-xs break-all'>
            {baseUrl}/chat/completions
          </span>
        </div>
        <pre className='text-zinc-300 overflow-x-auto font-mono text-xs leading-relaxed sm:text-[13px]'>
          {curlExample.split('\n').map((line, i) => (
            <div key={i} className='flex'>
              <span className='w-6 shrink-0 text-right text-zinc-600 select-none'>
                {i + 1}
              </span>
              <span className='pl-4 whitespace-pre'>{line}</span>
            </div>
          ))}
        </pre>
        <p className='text-zinc-500 mt-4 text-xs'>
          {t(
            'OpenAI-compatible endpoint (remember the /v1 suffix):'
          )}{' '}
          <span className='text-zinc-300 font-mono'>{baseUrl}</span>
        </p>
      </div>
    </CardShell>
  )
}

function QuickStartCard() {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)
  const { status } = useStatus()
  const serverAddress = (
    (status?.server_address as string | undefined) || window.location.origin
  ).replace(/\/+$/, '')

  const steps = [
    {
      title: t('Step 1. Create an API key'),
      description: t('sk-your-api-key'),
    },
    {
      title: t('Step 2. Configure the endpoint'),
      description: `${serverAddress}/v1`,
    },
    {
      title: t('Pick a model'),
      description: t('Per-channel prefixes'),
    },
  ]

  return (
    <CardShell className='flex flex-col'>
      <div className='border-b px-5 py-3.5'>
        <div className='text-sm font-semibold'>{t('Getting started')}</div>
      </div>
      <div className='flex flex-1 flex-col justify-center gap-5 px-5 py-5'>
        {steps.map((step, index) => (
          <div key={step.title} className='relative flex gap-3'>
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className='bg-border absolute top-8 left-[11px] h-[calc(100%-8px)] w-px'
              />
            )}
            <span className='bg-primary/10 text-primary z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>
              {index + 1}
            </span>
            <div className='min-w-0'>
              <div className='text-sm font-medium'>{step.title}</div>
              <div className='text-muted-foreground truncate font-mono text-xs'>
                {step.description}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className='border-t px-5 py-3'>
        {isAuthenticated ? (
          <Link
            to='/keys'
            className='text-primary hover:text-primary/80 inline-flex items-center gap-1 text-xs font-medium'
          >
            {t('Open API Keys')}
            <ArrowRight className='size-3.5' />
          </Link>
        ) : (
          <Link
            to='/sign-in'
            className='text-primary hover:text-primary/80 inline-flex items-center gap-1 text-xs font-medium'
          >
            {t('Sign in to get started')}
            <ArrowRight className='size-3.5' />
          </Link>
        )}
      </div>
    </CardShell>
  )
}

function ChannelsCard() {
  const { t } = useTranslation()

  return (
    <CardShell className='md:col-span-2'>
      <div className='border-b px-5 py-3.5'>
        <div className='text-sm font-semibold'>{t('Relay Channels')}</div>
      </div>
      <div className='flex flex-wrap content-center gap-2 px-5 py-5'>
        {RELAY_CHANNELS.map((channel) => (
          <span
            key={channel.prefix}
            className='border-border/60 bg-muted/40 hover:border-primary/40 hover:bg-primary/5 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors'
          >
            <span className='text-foreground/80 font-medium'>
              {channel.name}
            </span>
            <span className='text-muted-foreground font-mono'>
              {channel.prefix}
            </span>
          </span>
        ))}
      </div>
    </CardShell>
  )
}

function ModelCountCard() {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)

  const modelsQuery = useQuery({
    queryKey: ['home', 'user-models'],
    queryFn: async () => requireServerSuccess(await getUserModels()),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const modelCount = modelsQuery.data?.data?.length ?? 0

  return (
    <CardShell className='flex flex-col justify-center'>
      <div
        aria-hidden
        className='pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-cyan-500/10 blur-3xl'
      />
      <div className='relative flex flex-col items-center gap-1 px-5 py-6 text-center'>
        <div className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>
          {t('Available models')}
        </div>
        {isAuthenticated ? (
          <div className='bg-gradient-to-r from-blue-500 to-cyan-400 bg-clip-text text-5xl font-bold text-transparent tabular-nums'>
            {modelCount}
          </div>
        ) : (
          <Link
            to='/sign-in'
            className='text-muted-foreground hover:text-foreground mt-2 text-xs'
          >
            {t('Sign in to see your available models.')}
          </Link>
        )}
      </div>
    </CardShell>
  )
}

export function HomeBento() {
  return (
    <section className='relative z-10 px-6 pb-20'>
      <div className='mx-auto grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-3'>
        <EndpointTerminal />
        <QuickStartCard />
        <ChannelsCard />
        <ModelCountCard />
      </div>
    </section>
  )
}
