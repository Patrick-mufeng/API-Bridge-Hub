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
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useStatus } from '@/hooks/use-status'

export function EndpointStrip() {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { copyToClipboard } = useCopyToClipboard()
  const [copied, setCopied] = useState(false)

  const serverAddress = (
    (status?.server_address as string | undefined) || window.location.origin
  ).replace(/\/+$/, '')
  const endpoint = `${serverAddress}/v1/chat/completions`

  const handleCopy = async () => {
    const ok = await copyToClipboard(endpoint)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className='relative z-10 px-6 pb-20'>
      <div className='mx-auto flex max-w-2xl flex-col items-center gap-3'>
        <div
          data-endpoint
          className='border-border/70 bg-card/60 inline-flex max-w-full items-center gap-2 rounded-full border py-2 pr-2 pl-4 shadow-sm backdrop-blur-sm'
        >
          <span className='rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-500'>
            POST
          </span>
          <span className='text-foreground/85 truncate font-mono text-xs sm:text-sm'>
            {endpoint}
          </span>
          <button
            type='button'
            onClick={() => void handleCopy()}
            aria-label={t('Copy example')}
            className='hover:bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors'
          >
            {copied ? (
              <Check className='text-primary size-3.5' />
            ) : (
              <Copy className='text-muted-foreground size-3.5' />
            )}
          </button>
        </div>
        <Link
          to='/keys'
          className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors'
        >
          {t('Full connection guide lives on the API Keys page.')}
          <ArrowRight className='size-3.5' />
        </Link>
      </div>
    </div>
  )
}
