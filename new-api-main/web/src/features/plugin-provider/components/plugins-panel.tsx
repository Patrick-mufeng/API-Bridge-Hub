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
  Download,
  Loader2,
  Megaphone,
  PackageOpen,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  listInstalledPlugins,
  listPluginMarket,
  searchPluginMarket,
  upgradePlugins,
} from '../api'
import type { InstalledPlugin, MarketPlugin } from '../types'
import { InstalledRow } from './installed-row'
import { PluginDetail } from './plugin-detail'
import { PluginSection } from './plugin-section'

/**
 * The plugin market, laid out as magpie lays it out: Discover and Installed
 * as two tabs; a search field that reaches npm for what the community's list
 * does not have; the mirror switch beside it; and Discover split by what a
 * plugin is for rather than by who wrote it.
 *
 * A subscription is what this relay can serve: it signs in from the
 * Providers tab. The others install and do nothing here, which the heading
 * says plainly rather than pretending otherwise.
 */
export function PluginsPanel() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const [tab, setTab] = useState<'discover' | 'installed'>('discover')
  const [query, setQuery] = useState('')
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<MarketPlugin[] | null>(null)
  const [opened, setOpened] = useState<MarketPlugin | null>(null)

  const installedQuery = useQuery({
    queryKey: ['plugin-provider', 'plugins'],
    queryFn: async () =>
      requireServerSuccess(await listInstalledPlugins()).data,
    retry: false,
  })

  const marketQuery = useQuery({
    queryKey: ['plugin-provider', 'market'],
    queryFn: async () => requireServerSuccess(await listPluginMarket()).data,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })

  const findMutation = useMutation({
    mutationFn: async (q: string) =>
      requireServerSuccess(await searchPluginMarket(q)).data,
    onMutate: () => setFinding(true),
    onSuccess: (data) => setFound(data?.plugins ?? []),
    onError: (error) => {
      setFound([])
      handleServerError(error)
    },
    onSettled: () => setFinding(false),
  })

  const updateAllMutation = useMutation({
    mutationFn: async () => requireServerSuccess(await upgradePlugins()),
    onSuccess: () => {
      toast.success(t('Plugins updated'))
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  // held still between renders: an empty literal would be a new array every
  // time and re-run the memos under it
  const installed: InstalledPlugin[] = useMemo(
    () => installedQuery.data?.plugins ?? [],
    [installedQuery.data]
  )
  const market: MarketPlugin[] = useMemo(
    () => marketQuery.data?.plugins ?? [],
    [marketQuery.data]
  )

  /** What is shown: npm's answer when searching, the community's list otherwise. */
  const shown = useMemo(() => {
    const base = found ?? market
    const q = query.trim().toLowerCase()
    if (!q) {
      return base
    }
    return base.filter((plugin) =>
      [
        plugin.name,
        plugin.package,
        plugin.summary?.[lang] ?? plugin.summary?.en ?? '',
        (plugin.providers ?? []).join(' '),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [found, market, query, lang])

  /** Discover, split the way magpie splits it. */
  const groups = useMemo(() => {
    const by = (kind: string) =>
      shown.filter((plugin) => (plugin.kind || 'provider') === kind)
    return [
      {
        kind: 'provider',
        title: t('Subscriptions'),
        hint: t(
          'what this relay can serve: signed in, then registered as channels'
        ),
      },
      {
        kind: 'middleware',
        title: t('Gateway middleware'),
        hint: t('runs in the gateway on what every agent sends and gets back'),
      },
      {
        kind: 'agent',
        title: t('Agents'),
        hint: t('agents with no setup of their own'),
      },
      {
        kind: 'tools',
        title: t('Tools'),
        hint: t('tools every agent can call'),
      },
      {
        kind: 'page',
        title: t('Pages'),
        hint: t('pages of their own in this window'),
      },
    ].map((group) => ({ ...group, plugins: by(group.kind) }))
  }, [shown, t])

  const outdated = installed.filter((plugin) => plugin.update && !plugin.off)

  if (installedQuery.isLoading || marketQuery.isLoading) {
    return <LoadingState message={t('Loading plugins…')} />
  }
  if (installedQuery.isError || marketQuery.isError) {
    const error = installedQuery.error ?? marketQuery.error
    return (
      <ErrorState
        title={t("We couldn't load the plugins.")}
        description={error instanceof Error ? error.message : undefined}
        onRetry={() => {
          void installedQuery.refetch()
          void marketQuery.refetch()
        }}
      />
    )
  }

  return (
    <div className='space-y-3'>
      {/* tabs, search and the mirror switch, as magpie's header holds them */}
      <div className='flex flex-wrap items-center gap-2'>
        <div
          role='tablist'
          aria-label={t('Plugins')}
          className='bg-muted inline-flex rounded-md p-0.5'
        >
          {(
            [
              ['discover', t('Discover')],
              [
                'installed',
                installed.length
                  ? t('Installed · {{n}}', { n: installed.length })
                  : t('Installed'),
              ],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type='button'
              role='tab'
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                tab === id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className='relative min-w-0 flex-1 sm:max-w-xs'>
          <Search
            className='text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2'
            aria-hidden='true'
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && query.trim()) {
                findMutation.mutate(query.trim())
              }
            }}
            placeholder={t('Search plugins and npm…')}
            aria-label={t('Search plugins')}
            className='h-8 pl-7 text-xs'
          />
          {finding ? (
            <Loader2
              className='text-muted-foreground absolute top-1/2 right-2 size-3.5 -translate-y-1/2 animate-spin'
              aria-hidden='true'
            />
          ) : null}
        </div>

        {query.trim() ? (
          <Button
            variant='outline'
            size='sm'
            disabled={finding}
            onClick={() => findMutation.mutate(query.trim())}
          >
            <Search data-icon='inline-start' aria-hidden='true' />
            {t('Find on npm')}
          </Button>
        ) : null}

        <span className='grow' />

        {tab === 'installed' ? (
          <Button
            variant='outline'
            size='sm'
            disabled={updateAllMutation.isPending}
            onClick={() => updateAllMutation.mutate()}
          >
            {updateAllMutation.isPending ? (
              <Loader2
                data-icon='inline-start'
                className='animate-spin'
                aria-hidden='true'
              />
            ) : (
              <RefreshCw data-icon='inline-start' aria-hidden='true' />
            )}
            {t('Check for updates')}
          </Button>
        ) : null}
      </div>

      <PluginLists
        tab={tab}
        installed={installed}
        outdated={outdated}
        shown={shown}
        groups={groups}
        updating={updateAllMutation.isPending}
        onUpdateAll={() => updateAllMutation.mutate()}
        onOpen={setOpened}
      />

      {opened ? (
        <PluginDetail plugin={opened} onClose={() => setOpened(null)} />
      ) : null}
    </div>
  )
}

/** The list under the tabs: what is installed, or the market's groups. */
function PluginLists(props: {
  tab: 'discover' | 'installed'
  installed: InstalledPlugin[]
  outdated: InstalledPlugin[]
  shown: MarketPlugin[]
  groups: {
    kind: string
    title: string
    hint: string
    plugins: MarketPlugin[]
  }[]
  updating: boolean
  onUpdateAll: () => void
  onOpen: (plugin: MarketPlugin) => void
}) {
  const { t } = useTranslation()

  if (props.tab === 'installed') {
    if (props.installed.length === 0) {
      return (
        <EmptyState
          title={t('No plugins yet')}
          description={t(
            'Add a subscription or a middleware from Discover. A subscription signs in from the Providers tab.'
          )}
        />
      )
    }
    return (
      <div className='space-y-2'>
        {props.outdated.length > 0 ? (
          <OutdatedNotice
            outdated={props.outdated}
            updating={props.updating}
            onUpdateAll={props.onUpdateAll}
          />
        ) : null}
        {props.installed.map((plugin) => (
          <InstalledRow key={plugin.spec} plugin={plugin} />
        ))}
      </div>
    )
  }

  if (props.shown.length === 0) {
    return (
      <EmptyState
        title={t('Nothing matches.')}
        description={t('Press Find on npm to look for a package by name.')}
      />
    )
  }

  return (
    <div className='space-y-4'>
      {props.groups.map((group) =>
        group.plugins.length > 0 ? (
          <PluginSection
            key={group.kind}
            title={group.title}
            hint={group.hint}
            plugins={group.plugins}
            onOpen={props.onOpen}
          />
        ) : null
      )}
      {props.installed.length > 0 ? (
        <p className='text-muted-foreground flex items-center gap-1.5 text-xs'>
          <PackageOpen className='size-3.5' aria-hidden='true' />
          {t('{{n}} plugin(s) installed', { n: props.installed.length })}
          <Badge variant='outline' className='ml-1'>
            {t('Sign in from Providers')}
          </Badge>
        </p>
      ) : null}
    </div>
  )
}

/** A newer version of something installed: what it is, and one button. */
function OutdatedNotice(props: {
  outdated: InstalledPlugin[]
  updating: boolean
  onUpdateAll: () => void
}) {
  const { t } = useTranslation()
  const one = props.outdated.length === 1
  const words = one
    ? t('A newer version of {{name}} is out', { name: props.outdated[0].name })
    : t('Newer versions of {{n}} plugins are out', { n: props.outdated.length })

  return (
    <div className='bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2'>
      <Megaphone className='size-3.5 shrink-0' aria-hidden='true' />
      <span className='min-w-0 flex-1 text-xs'>{words}</span>
      <Button size='sm' disabled={props.updating} onClick={props.onUpdateAll}>
        {props.updating ? (
          <Loader2
            data-icon='inline-start'
            className='animate-spin'
            aria-hidden='true'
          />
        ) : (
          <Download data-icon='inline-start' aria-hidden='true' />
        )}
        {t('Update all ({{n}})', { n: props.outdated.length })}
      </Button>
    </div>
  )
}
