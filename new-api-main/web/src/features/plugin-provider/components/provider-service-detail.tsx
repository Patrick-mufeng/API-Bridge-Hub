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
import {
  BarChart3,
  Boxes,
  CalendarCheck,
  Loader2,
  RefreshCw,
  Settings2,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  checkinPluginProvider,
  getPluginProvider,
  getPluginProviderPage,
  registerPluginProvider,
  removePluginAccount,
  syncPluginHealth,
} from '../api'
import type { CheckinEntry, PluginAccount, ProviderChannel } from '../types'
import { AccountRow } from './account-row'
import { ModelTable } from './model-table'
import { SettingsPanel } from './settings-panel'
import { UsagePanel } from './usage-panel'

const SECTIONS = [
  { id: 'accounts', icon: Users, label: 'Accounts' },
  { id: 'models', icon: Boxes, label: 'Models' },
  { id: 'usage', icon: BarChart3, label: 'Usage' },
  { id: 'settings', icon: Settings2, label: 'Settings' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** What each check-in outcome means, in a word. */
const OUTCOME: Record<string, { label: string; good: boolean }> = {
  claimed: { label: 'Checked in', good: true },
  done: { label: 'Already checked in', good: true },
  ineligible: { label: 'Not eligible', good: false },
  inactive: { label: 'No check-in now', good: false },
  captcha: { label: 'Needs a captcha', good: false },
  failed: { label: 'Failed', good: false },
}

/**
 * One provider's own page, folded into its row: every account it holds and
 * what each is worth, what the relay spent through it, and the switches its
 * plugin declares.
 *
 * The three are the same page because they answer one question together.
 * An operator comes here when an account runs low: they read the allowance,
 * look at what drew it down, and press whatever the vendor offers as a top
 * up. Splitting them across pages would mean three loads of the same thing.
 */
export function ProviderServiceDetail(props: {
  provider: string
  onSignIn: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionId>('accounts')
  // the account the operator asked to take out, held while the dialog asks
  const [removeTarget, setRemoveTarget] = useState<PluginAccount | null>(null)

  const pageQuery = useQuery({
    queryKey: ['plugin-provider', 'page', props.provider],
    queryFn: async () =>
      requireServerSuccess(await getPluginProviderPage(props.provider)).data,
    retry: false,
  })

  // what the plugin declares it can do, for the tabs to say what it cannot
  const detailQuery = useQuery({
    queryKey: ['plugin-provider', 'detail', props.provider],
    queryFn: async () =>
      requireServerSuccess(await getPluginProvider(props.provider)).data,
    retry: false,
  })

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })

  const checkinMutation = useMutation({
    mutationFn: async (account?: string) =>
      requireServerSuccess(
        await checkinPluginProvider(props.provider, account)
      ),
    onSuccess: (res) => {
      const result = res.data
      if (!result) {
        return
      }
      if (result.claimed > 0) {
        toast.success(t('Checked in {{n}} account(s)', { n: result.claimed }))
      } else if (result.failed > 0) {
        toast.warning(t('No account was checked in'))
      } else {
        toast.info(t('Nothing to claim right now'))
      }
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  const healthMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await syncPluginHealth(props.provider)),
    onSuccess: (res) => {
      toast.success(
        t('Account health checked: {{summary}}', {
          summary: res.data?.summary || t('done'),
        })
      )
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  const registerMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(
        await registerPluginProvider({ provider: props.provider })
      ),
    onSuccess: () => {
      toast.success(t('Channel registered'))
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  // taking an account out drops its key from every channel serving it, and
  // the plugin's sign-in with it: one action, because half of it leaves a
  // key nobody can renew or a sign-in nothing can reach
  const removeMutation = useMutation({
    mutationFn: async (account: string) =>
      requireServerSuccess(await removePluginAccount(props.provider, account)),
    onSuccess: (res) => {
      const removed = res.data?.removed?.length ?? 0
      if (removed > 0) {
        toast.success(
          t('Account removed; its channel had no account left and went with it')
        )
      } else {
        toast.success(t('Account removed'))
      }
      setRemoveTarget(null)
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  if (pageQuery.isLoading) {
    return (
      <LoadingState
        message={t('Loading {{name}}…', { name: props.provider })}
      />
    )
  }
  if (pageQuery.isError || !pageQuery.data) {
    return (
      <ErrorState
        title={t('We could not read this provider.')}
        description={
          pageQuery.error instanceof Error ? pageQuery.error.message : undefined
        }
        onRetry={() => void pageQuery.refetch()}
      />
    )
  }

  const page = pageQuery.data
  const accounts = page.accounts ?? []
  const channels = page.channels ?? []
  const usable = accounts.filter(
    (account) => !account.needs_sign_in && account.sign_in !== 'expired'
  ).length

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <p className='text-muted-foreground text-[11px]'>
            {t('{{usable}} of {{total}} account(s) usable', {
              usable,
              total: accounts.length,
            })}
            {page.api_root ? ` · ${page.api_root}` : ''}
          </p>
        </div>
        <div className='flex shrink-0 flex-wrap items-center gap-1.5'>
          {page.checkin ? (
            <Button
              size='sm'
              disabled={checkinMutation.isPending || accounts.length === 0}
              onClick={() => checkinMutation.mutate(undefined)}
              title={t(
                'Press the vendor’s daily check-in for every account at once.'
              )}
            >
              {checkinMutation.isPending ? (
                <Loader2
                  data-icon='inline-start'
                  className='animate-spin'
                  aria-hidden='true'
                />
              ) : (
                <CalendarCheck data-icon='inline-start' aria-hidden='true' />
              )}
              {t('Check in all')}
            </Button>
          ) : null}
          <Button variant='outline' size='sm' onClick={props.onSignIn}>
            {t('Sign in')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={healthMutation.isPending}
            onClick={() => healthMutation.mutate()}
          >
            {healthMutation.isPending ? (
              <Loader2
                data-icon='inline-start'
                className='animate-spin'
                aria-hidden='true'
              />
            ) : (
              <RefreshCw data-icon='inline-start' aria-hidden='true' />
            )}
            {t('Check accounts')}
          </Button>
        </div>
      </div>

      {checkinMutation.data?.data ? (
        <CheckinSummary entries={checkinMutation.data.data.accounts ?? []} />
      ) : null}

      {channels.length === 0 ? (
        <div className='bg-muted/30 rounded-md border px-2.5 py-2'>
          <p className='text-muted-foreground text-xs'>
            {t('This provider has no channel yet, so nothing can reach it.')}
          </p>
          <Button
            size='sm'
            className='mt-1.5'
            disabled={registerMutation.isPending}
            onClick={() => registerMutation.mutate()}
          >
            {registerMutation.isPending ? (
              <Loader2
                data-icon='inline-start'
                className='animate-spin'
                aria-hidden='true'
              />
            ) : (
              <RefreshCw data-icon='inline-start' aria-hidden='true' />
            )}
            {t('Register channel')}
          </Button>
        </div>
      ) : (
        <div className='flex flex-wrap gap-1'>
          {channels.map((channel) => (
            <ChannelChip key={channel.id} channel={channel} />
          ))}
        </div>
      )}

      {detailQuery.data ? (
        <CapabilityStrip
          usage={detailQuery.data.usage}
          checkin={detailQuery.data.checkin}
          renews={detailQuery.data.renews}
          options={detailQuery.data.options?.length ?? 0}
          fellBack={detailQuery.data.fell_back}
          listError={detailQuery.data.list_error}
          modelCount={detailQuery.data.models?.length ?? 0}
        />
      ) : null}

      <div
        role='tablist'
        aria-label={t('Details')}
        className='bg-muted inline-flex rounded-md p-0.5'
      >
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type='button'
            role='tab'
            aria-selected={section === item.id}
            onClick={() => setSection(item.id)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors',
              section === item.id
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <item.icon className='size-3' aria-hidden='true' />
            {t(item.label)}
          </button>
        ))}
      </div>

      {section === 'accounts' ? (
        <AccountsSection
          accounts={accounts}
          checkin={page.checkin}
          busy={checkinMutation.isPending || removeMutation.isPending}
          onCheckin={(account) => checkinMutation.mutate(account)}
          onRemove={setRemoveTarget}
          onSignIn={props.onSignIn}
        />
      ) : null}

      {section === 'models' ? (
        <ModelsSection provider={props.provider} />
      ) : null}

      {section === 'usage' ? <UsagePanel provider={props.provider} /> : null}

      {section === 'settings' ? (
        <SettingsPanel provider={props.provider} />
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null)
          }
        }}
        title={t('Remove this account?')}
        desc={t(
          'Its key comes out of every channel serving it, and the plugin forgets its sign-in. A channel left with no account goes with it; a pooled channel keeps serving the others. Requests already using it are not affected.'
        )}
        confirmText={t('Remove')}
        destructive
        isLoading={removeMutation.isPending}
        handleConfirm={() => {
          if (removeTarget) {
            removeMutation.mutate(removeTarget.key)
          }
        }}
      >
        {removeTarget ? (
          <div className='bg-muted/40 rounded-md border px-2.5 py-2 text-xs'>
            <div className='font-medium'>{removeTarget.label}</div>
            <div className='text-muted-foreground mt-0.5 font-mono text-[10px]'>
              {removeTarget.key}
            </div>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/**
 * The provider's models: what it serves, at what depth, for what price.
 *
 * A tab of its own rather than a corner of the settings: choosing between
 * them is the reason an operator opens a provider at all, and the numbers
 * that decide it — context, output, credits — do not fit in a badge.
 */
function ModelsSection(props: { provider: string }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['plugin-provider', 'detail', props.provider],
    queryFn: async () =>
      requireServerSuccess(await getPluginProvider(props.provider)).data,
    retry: false,
  })

  if (query.isLoading) {
    return <LoadingState message={t('Reading models…')} />
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title={t('We could not read its models.')}
        description={
          query.error instanceof Error ? query.error.message : undefined
        }
        onRetry={() => void query.refetch()}
      />
    )
  }
  return <ModelTable models={query.data.models ?? []} />
}

/** One channel this provider answers through, as a chip. */
function ChannelChip(props: { channel: ProviderChannel }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]',
        !props.channel.enabled && 'opacity-60'
      )}
      title={props.channel.name}
    >
      {props.channel.prefix ? (
        <span className='font-mono font-medium'>{props.channel.prefix}-</span>
      ) : null}
      <Badge variant='outline' className='text-[10px]'>
        {t('{{n}} model(s)', { n: props.channel.models })}
      </Badge>
      {props.channel.keys ? (
        <Badge variant='secondary' className='text-[10px]'>
          {t('{{n}} key(s)', { n: props.channel.keys })}
        </Badge>
      ) : null}
      <span className='text-muted-foreground font-mono text-[10px]'>
        p{props.channel.priority} · w{props.channel.weight}
      </span>
    </span>
  )
}

/** What a check-in just did, account by account. */
function CheckinSummary(props: { entries: CheckinEntry[] }) {
  const { t } = useTranslation()
  if (props.entries.length === 0) {
    return null
  }
  return (
    <div className='bg-muted/40 space-y-1 rounded-md border px-2.5 py-2'>
      <h4 className='text-xs font-semibold'>{t('Check-in result')}</h4>
      {props.entries.map((entry) => {
        const outcome = OUTCOME[entry.outcome] ?? {
          label: entry.outcome,
          good: false,
        }
        return (
          <div
            key={entry.account}
            className='flex flex-wrap items-center gap-1.5 text-[11px]'
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                outcome.good ? 'bg-emerald-500' : 'bg-destructive'
              )}
              aria-hidden='true'
            />
            <span className='font-medium'>{entry.label || entry.account}</span>
            <span className='text-muted-foreground'>{t(outcome.label)}</span>
            {entry.credit ? (
              <span className='text-emerald-600'>+{entry.credit}</span>
            ) : null}
            {entry.streak ? (
              <span className='text-muted-foreground'>
                {t('{{n}}-day streak', { n: entry.streak })}
              </span>
            ) : null}
            {entry.message ? (
              <span className='text-muted-foreground truncate'>
                {entry.message}
              </span>
            ) : null}
            {entry.error ? (
              <span className='text-destructive truncate'>{entry.error}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The accounts a provider holds, each with its allowance. */
function AccountsSection(props: {
  accounts: PluginAccount[]
  checkin: boolean
  busy: boolean
  onCheckin: (account: string) => void
  onRemove: (account: PluginAccount) => void
  onSignIn: () => void
}) {
  const { t } = useTranslation()
  if (props.accounts.length === 0) {
    return (
      <EmptyState
        title={t('No account signed in.')}
        description={t(
          'Sign in with your own account; what it holds shows up here with what each is worth.'
        )}
      />
    )
  }
  return (
    <div className='space-y-1.5'>
      {props.accounts.map((account) => (
        <AccountRow
          key={account.key}
          account={account}
          busy={props.busy}
          onCheckin={
            props.checkin ? () => props.onCheckin(account.key) : undefined
          }
          onSignOut={() => props.onRemove(account)}
          onSignIn={props.onSignIn}
        />
      ))}
    </div>
  )
}

/**
 * What a plugin says it can do, in one line.
 *
 * Every plugin is written to a contract that lets it declare usage,
 * check-in, sign-in renewal, its own switches, a live model list. A provider
 * installed a minute ago reports these the same way a familiar one does, so
 * the console says which ones this plugin declared rather than leaving the
 * operator to find the gaps page by page.
 *
 * A hook it did not declare is drawn plainly, not as a fault: an absent
 * feature and a broken one are different things.
 */
function CapabilityStrip(props: {
  usage: boolean
  checkin: boolean
  renews: boolean
  options: number
  fellBack?: boolean
  listError?: string
  modelCount: number
}) {
  const { t } = useTranslation()
  const items = [
    {
      key: 'models',
      label: t('models'),
      on: props.modelCount > 0,
      n: props.modelCount,
    },
    { key: 'usage', label: t('usage'), on: props.usage },
    { key: 'checkin', label: t('check-in'), on: props.checkin },
    { key: 'renews', label: t('renews'), on: props.renews },
    {
      key: 'options',
      label: t('settings'),
      on: props.options > 0,
      n: props.options,
    },
  ]
  return (
    <div className='space-y-1'>
      <div className='flex flex-wrap items-center gap-1'>
        {items.map((item) => (
          <span
            key={item.key}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]',
              item.on
                ? 'text-foreground'
                : 'text-muted-foreground border-dashed'
            )}
            title={
              item.on
                ? t('This plugin provides it')
                : t('This plugin does not provide it')
            }
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                item.on ? 'bg-emerald-500' : 'bg-muted-foreground/30'
              )}
              aria-hidden='true'
            />
            {item.label}
            {item.n ? (
              <span className='text-muted-foreground font-mono'>{item.n}</span>
            ) : null}
            {item.on ? null : (
              <span className='sr-only'>{t('not provided')}</span>
            )}
          </span>
        ))}
      </div>
      {props.fellBack ? (
        <p className='text-[10px] text-amber-600'>
          {t(
            'The plugin could not reach its vendor for a model list and gave a default one; the list below may be short.'
          )}
          {props.listError ? ' — ' + props.listError : ''}
        </p>
      ) : null}
    </div>
  )
}
