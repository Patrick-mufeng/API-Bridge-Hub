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
import {
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  UserPlus,
  XCircle,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MOTION_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

import type { PluginProviderOffer } from '../types'
import { ProviderServiceDetail } from './provider-service-detail'

/**
 * One provider a plugin serves, as a row that opens in place.
 *
 * The row is what an operator scans — what it is, whether an account is
 * signed in, how much of it is registered. Opening it hands the rest to the
 * detail view: the accounts with their allowances, the plugin's switches,
 * and what the relay spent through it. Opening is AnimatePresence's, so the
 * panel folds out rather than appearing, and closing folds it back.
 */
export function ProviderServiceCard(props: {
  offer: PluginProviderOffer
  defaultOpen?: boolean
  onSignIn: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const shouldReduce = useReducedMotion()

  const panelId = `provider-service-${props.offer.provider}`

  return (
    <div
      className={cn(
        'bg-card overflow-hidden rounded-lg border shadow-xs transition-colors',
        open && 'border-primary/40'
      )}
    >
      <div className='flex flex-wrap items-center gap-2 px-3 py-2.5'>
        <button
          type='button'
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-controls={panelId}
          className='focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3'
        >
          <motion.span
            animate={{ rotate: open ? 0 : -90 }}
            transition={MOTION_TRANSITION.fast}
            className='text-muted-foreground inline-flex shrink-0'
            aria-hidden='true'
          >
            <ChevronDown className='size-4' />
          </motion.span>
          <span className='min-w-0'>
            <span className='flex flex-wrap items-center gap-1.5'>
              <span className='truncate text-sm font-semibold'>
                {props.offer.name}
              </span>
              <Badge variant='outline' className='font-mono text-[10px]'>
                {props.offer.provider}
              </Badge>
              {props.offer.signed_in ? (
                <Badge variant='secondary' className='gap-1 text-[10px]'>
                  <CheckCircle2 className='size-2.5' aria-hidden='true' />
                  {t('Signed in')}
                </Badge>
              ) : (
                <Badge
                  variant='outline'
                  className='text-muted-foreground gap-1 text-[10px]'
                >
                  <XCircle className='size-2.5' aria-hidden='true' />
                  {t('No account')}
                </Badge>
              )}
            </span>
            <span className='text-muted-foreground mt-0.5 block text-[11px]'>
              {t('{{accounts}} account(s), {{models}} model(s)', {
                accounts: props.offer.accounts.length,
                models: props.offer.models.length,
              })}
            </span>
          </span>
        </button>

        <div className='flex shrink-0 items-center gap-1.5'>
          <Button variant='outline' size='sm' onClick={props.onSignIn}>
            <UserPlus data-icon='inline-start' aria-hidden='true' />
            {t('Sign in')}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            aria-controls={panelId}
          >
            <ClipboardList data-icon='inline-start' aria-hidden='true' />
            {open ? t('Collapse') : t('Details')}
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key='panel'
            id={panelId}
            initial={shouldReduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={shouldReduce ? undefined : { height: 0, opacity: 0 }}
            transition={MOTION_TRANSITION.default}
            className='overflow-hidden'
          >
            <div className='border-t px-3 py-3'>
              <ProviderServiceDetail
                provider={props.offer.provider}
                onSignIn={props.onSignIn}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
