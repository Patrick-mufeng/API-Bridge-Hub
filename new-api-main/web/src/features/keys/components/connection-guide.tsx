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
import { BookOpen, ChevronDown, Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { IconBadge } from '@/components/ui/icon-badge'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useStatus } from '@/hooks/use-status'
import { getUserModels } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

interface ConnectionGuideProps {
  /** Expand the guide on first render (e.g. when embedded on the home page). */
  defaultOpen?: boolean
}

export function ConnectionGuide(props: ConnectionGuideProps) {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { copyToClipboard } = useCopyToClipboard()
  const user = useAuthStore((state) => state.auth.user)
  const isAuthenticated = !!user
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const [exampleModel, setExampleModel] = useState('')

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    void getUserModels()
      .then((res) => {
        if (cancelled) return
        const models = res?.data ?? []
        if (models.length > 0) setExampleModel(models[0])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const serverAddress = (
    (status?.server_address as string | undefined) || window.location.origin
  ).replace(/\/+$/, '')
  const baseUrl = `${serverAddress}/v1`
  const modelName = exampleModel || 'your-model'

  const curlExample = useMemo(
    () =>
      [
        `curl ${baseUrl}/chat/completions \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer ${t('sk-your-api-key')}" \\`,
        `  -d '{"model":"${modelName}","messages":[{"role":"user","content":"${t('Hello')}"}]}'`,
      ].join('\n'),
    [baseUrl, modelName, t]
  )

  const steps = [
    {
      title: t('Step 1. Create an API key'),
      description: t(
        'Click "Create API Key" on this page and copy the sk-... secret. Keep it private.'
      ),
    },
    {
      title: t('Step 2. Configure the endpoint'),
      description: t(
        'OpenAI-compatible endpoint (remember the /v1 suffix):'
      ),
      code: baseUrl,
    },
    {
      title: t('Step 3. Pick a model'),
      description: t(
        'Each upstream channel prefixes its models (wb:, qd:, cl:, ocz:, tr:, cg: ...). Open Model Square for the full catalog.'
      ),
    },
  ]

  return (
    <div className='bg-card text-card-foreground rounded-lg border shadow-sm'>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className='hover:bg-muted/40 flex w-full items-center gap-2 px-4 py-3 text-left'
          aria-expanded={open}
        >
          <IconBadge tone='info' size='sm'>
            <BookOpen />
          </IconBadge>
          <span className='text-sm font-semibold'>
            {t('Connection Guide')}
          </span>
          <span className='text-muted-foreground hidden text-xs sm:inline'>
            {t('Three steps to connect your apps.')}
          </span>
          <ChevronDown
            className={cn(
              'text-muted-foreground ml-auto size-4 transition-transform',
              open && 'rotate-180'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className='flex flex-col gap-4 border-t px-4 py-4'>
            {steps.map((step, index) => (
              <div key={step.title} className='flex flex-col gap-1.5'>
                <div className='flex items-center gap-2'>
                  <span className='bg-primary/10 text-primary flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>
                    {index + 1}
                  </span>
                  <span className='text-sm font-medium'>{step.title}</span>
                </div>
                <p className='text-muted-foreground pl-7 text-xs leading-relaxed'>
                  {step.description}
                </p>
                {step.code && (
                  <pre className='bg-muted/50 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs'>
                    {step.code}
                  </pre>
                )}
              </div>
            ))}

            <div className='flex flex-col gap-1.5'>
              <div className='flex items-center justify-between gap-2'>
                <span className='text-sm font-medium'>{t('Example request')}</span>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => void copyToClipboard(curlExample)}
                >
                  <Copy data-icon='inline-start' />
                  <span>{t('Copy example')}</span>
                </Button>
              </div>
              <pre className='bg-muted/50 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs'>
                {curlExample}
              </pre>
            </div>

            <p className='text-muted-foreground text-xs leading-relaxed'>
              {t(
                'Common clients (Cherry Studio, NextChat, Cline, etc.): pick the OpenAI-compatible provider, set the Base URL to the endpoint above, and paste your key.'
              )}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
