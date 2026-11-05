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
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  RefreshCw,
  UserMinus,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { PluginAccount, QuotaWindow } from '../types'

/** A window's bar: how much of it is spent, and when it starts over. */
function WindowBar({ window: w }: { window: QuotaWindow }) {
  const { t } = useTranslation()
  const used = Math.max(0, Math.min(100, w.used || 0))
  // a window at its cap reads as full; the colour says how close it is
  const tone = barTone(used)
  const resets = w.resets_at ? new Date(w.resets_at) : null
  const when = resetWords(resets, w.reset_secs, t)

  return (
    <div className='min-w-0'>
      <div className='flex items-baseline justify-between gap-2'>
        <span className='truncate text-[11px] font-medium'>{w.name}</span>
        <span className='text-muted-foreground shrink-0 font-mono text-[10px]'>
          {windowWords(w, used)}
        </span>
      </div>
      <div className='bg-muted mt-0.5 h-1.5 w-full overflow-hidden rounded-full'>
        <div
          className={cn('h-full rounded-full transition-all', tone)}
          style={{ width: `${used}%` }}
        />
      </div>
      {when ? (
        <div className='text-muted-foreground mt-0.5 flex items-center gap-1 text-[10px]'>
          <CalendarClock className='size-2.5' aria-hidden='true' />
          {when}
        </div>
      ) : null}
    </div>
  )
}

/** A span of seconds in the shortest form that still says it. */
function shortSpan(seconds: number) {
  if (seconds >= 86400) {
    return `${Math.round(seconds / 86400)}d`
  }
  if (seconds >= 3600) {
    return `${Math.round(seconds / 3600)}h`
  }
  return `${Math.round(seconds / 60)}m`
}

/** How full a window is, as the colour of its bar. */
function barTone(used: number) {
  if (used >= 95) {
    return 'bg-destructive'
  }
  if (used >= 75) {
    return 'bg-amber-500'
  }
  return 'bg-emerald-500'
}

/** When a window starts over, said either as an instant or as a wait. */
function resetWords(
  resets: Date | null,
  resetSecs: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (resets && !Number.isNaN(resets.getTime())) {
    return resets.toLocaleString()
  }
  if (resetSecs) {
    return t('in {{s}}', { s: shortSpan(resetSecs) })
  }
  return ''
}

/**
 * One account of a provider: what it is, how much of it is left, and
 * whether it can be used right now.
 *
 * This is the part an operator picks an account by — a subscription pool is
 * part spent, and the numbers are what say which part. Every field is
 * optional: a vendor that reports nothing leaves the row without figures
 * rather than hiding the account.
 */
export function AccountRow({
  account,
  onSignIn,
  onSignOut,
  onCheckin,
  busy,
}: {
  account: PluginAccount
  onSignIn?: () => void
  onSignOut?: () => void
  /** Press this account's daily check-in, when its vendor has one. */
  onCheckin?: () => void
  busy?: boolean
}) {
  const { t } = useTranslation()
  const lapsed = account.needs_sign_in || account.sign_in === 'expired'
  // a pooled channel stays on while any of its keys works, so what says
  // this account is in use is its own key, not the channel
  const off = account.key_on === false

  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2',
        lapsed && 'border-destructive/40 bg-destructive/5',
        off && !lapsed && 'opacity-70'
      )}
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='truncate text-xs font-medium'>{account.label}</span>
        <Badge variant='outline' className='font-mono text-[10px]'>
          {account.type}
        </Badge>
        {account.plan ? (
          <Badge variant='secondary' className='text-[10px]'>
            {account.plan}
          </Badge>
        ) : null}
        {lapsed ? (
          <Badge variant='destructive' className='gap-1 text-[10px]'>
            <AlertTriangle className='size-2.5' aria-hidden='true' />
            {t('Sign in again')}
          </Badge>
        ) : null}
        {off && !lapsed ? (
          <Badge variant='outline' className='text-[10px]'>
            {t('Key off')}
          </Badge>
        ) : null}
        {account.key_index !== undefined && account.key_index >= 0 ? (
          <Badge variant='outline' className='font-mono text-[10px]'>
            {t('key #{{n}}', { n: account.key_index })}
          </Badge>
        ) : null}
        <span className='grow' />
        {onCheckin ? (
          <Button variant='ghost' size='sm' disabled={busy} onClick={onCheckin}>
            <CalendarCheck data-icon='inline-start' aria-hidden='true' />
            {t('Check in')}
          </Button>
        ) : null}
        {onSignIn ? (
          <Button variant='ghost' size='sm' disabled={busy} onClick={onSignIn}>
            <RefreshCw data-icon='inline-start' aria-hidden='true' />
            {lapsed ? t('Sign in again') : t('Sign in')}
          </Button>
        ) : null}
        {onSignOut ? (
          <Button variant='ghost' size='sm' disabled={busy} onClick={onSignOut}>
            <UserMinus data-icon='inline-start' aria-hidden='true' />
            {t('Remove')}
          </Button>
        ) : null}
      </div>

      {lapsed && account.error ? (
        <p className='text-destructive mt-1 text-[11px]'>
          {/* a plugin writes its own message, and it names the vendor's own
              app; what an operator needs here is what to press on this page */}
          {account.error.replace(/\s*Sign in to it again in magpie:.*$/i, '')}
        </p>
      ) : null}

      {account.windows?.length ? (
        <div className='mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3'>
          {account.windows.map((w) => (
            <WindowBar key={w.name} window={w} />
          ))}
        </div>
      ) : null}

      {account.resets ? (
        <p className='text-muted-foreground mt-1 text-[10px]'>
          {t('{{n}} rate-limit reset(s) left', { n: account.resets })}
        </p>
      ) : null}
    </div>
  )
}

/**
 * What a window says about itself: the figures the plugin gave, and the
 * percentage it amounts to.
 *
 * A vendor that reports credits reports them as an amount against a limit —
 * "29.78 / 1000 credits" — and a bare "3%" answers none of the questions an
 * operator opens this row with: how much is left, of what. The percentage is
 * still drawn, in the bar and after the numbers, because it is what compares
 * two windows of different sizes.
 *
 * A plugin that sends its own wording (display) is taken at its word: it
 * knows its vendor's units better than this console does.
 */
function windowWords(w: QuotaWindow, used: number) {
  if (w.display) {
    return w.display
  }
  const percent = `${Math.round(used)}%`
  const limit = formatAmount(w.limit)
  // amount is what the window says is used; a plugin may leave it out and
  // send only the share (used) and the size (limit), which still reads as
  // "of 500 credits" once the figure is worked back from the percentage
  const amount = formatAmount(w.amount ?? shareOf(w.used, w.limit))
  if (limit === '') {
    return percent
  }
  // the unit is the vendor's own ("credits", "usd"): shown as it came
  const unit = w.unit ? ` ${w.unit}` : ''
  return `${amount} / ${limit}${unit} · ${percent}`
}

/** How much of a limit a percentage is, for a plugin that sends no amount. */
function shareOf(used: number | undefined, limit: number | undefined) {
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined
  }
  return (limit * used) / 100
}

/** A number as the window has it, without trailing zeros a vendor padded. */
function formatAmount(value: number | undefined) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return ''
  }
  // credits and cents alike are read at two places at most
  return String(Math.round(value * 100) / 100)
}
