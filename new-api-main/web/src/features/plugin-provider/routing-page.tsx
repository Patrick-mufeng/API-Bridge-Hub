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
import { ArrowDownUp, RadioTower, Search } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MOTION_TRANSITION } from '@/lib/motion'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { listPluginRoutes } from './api'
import { RoutingEmpty, RoutingRow } from './components/routing-map'
import { groupRoutes } from './lib/routes'

/** What a stat's number is coloured by. */
const TONE: Record<'plain' | 'accent' | 'bad', string> = {
  plain: '',
  accent: 'text-primary',
  bad: 'text-destructive',
}

/**
 * Routing: every model name this hub answers to, and who answers it.
 *
 * A client whose vendor's own documentation names a model asks for
 * "glm-5.3", not "workbuddy-glm-5.3". Those are the names here. A request
 * for one reaches the first provider in line and falls to the next only when
 * the first cannot answer.
 *
 * Names that reach the same providers in the same order are drawn once: on a
 * hub serving one subscription that is every name there is, and a row each
 * would say the same thing seventeen times.
 */
export function RoutingPage() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const routesQuery = useQuery({
    queryKey: ['plugin-provider', 'routes'],
    queryFn: async () => requireServerSuccess(await listPluginRoutes()).data,
    retry: false,
    refetchInterval: 30_000,
  })

  // held still between renders: an empty literal would be a new object each
  // time and re-run every memo under it
  const routes = useMemo(
    () => routesQuery.data?.routes ?? {},
    [routesQuery.data]
  )
  const names = useMemo(() => Object.keys(routes).sort(), [routes])
  const groups = useMemo(() => groupRoutes(routes), [routes])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return groups
    }
    return groups.filter(
      (group) =>
        group.names.some((name) => name.toLowerCase().includes(q)) ||
        group.members.some((member) => member.name.toLowerCase().includes(q))
    )
  }, [groups, query])

  // a name nobody serving cannot be reached at all; one with several
  // providers is the case routing exists for
  const orphaned = names.filter((name) =>
    (routes[name] ?? []).every((member) => !member.enabled)
  ).length
  const multi = names.filter((name) => (routes[name] ?? []).length > 1).length

  let body = null
  if (routesQuery.isLoading) {
    body = <LoadingState message={t('Reading the routing…')} />
  } else if (routesQuery.isError) {
    body = (
      <ErrorState
        title={t('We could not read the routes.')}
        description={
          routesQuery.error instanceof Error
            ? routesQuery.error.message
            : undefined
        }
        onRetry={() => void routesQuery.refetch()}
      />
    )
  } else if (names.length === 0) {
    body = <RoutingEmpty />
  } else {
    body = (
      <RoutingBody
        names={names}
        shown={shown}
        multi={multi}
        orphaned={orphaned}
        query={query}
        onQuery={setQuery}
      />
    )
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex min-w-0 items-center gap-2'>
          <span className='truncate'>{t('Routing')}</span>
          <Badge variant='outline' className='shrink-0'>
            {t('Admin')}
          </Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>{body}</SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

/** The map itself: what is routed, drawn in the order it is tried. */
function RoutingBody(props: {
  names: string[]
  shown: ReturnType<typeof groupRoutes>
  multi: number
  orphaned: number
  query: string
  onQuery: (value: string) => void
}) {
  const { t } = useTranslation()
  const shouldReduce = useReducedMotion()

  let list = null
  if (props.shown.length === 0) {
    list = (
      <p className='text-muted-foreground py-8 text-center text-xs'>
        {t('Nothing matches.')}
      </p>
    )
  } else {
    list = (
      <motion.div
        className='space-y-1.5'
        initial={shouldReduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={MOTION_TRANSITION.fast}
      >
        {props.shown.map((group, index) => (
          <RoutingRow key={group.key} group={group} index={index} />
        ))}
      </motion.div>
    )
  }

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
          <ArrowDownUp className='size-4' aria-hidden='true' />
        </span>
        <div className='min-w-0 flex-1'>
          <h3 className='text-sm font-semibold'>
            {t('Model names and who serves them')}
          </h3>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t(
              'A request for one of these names goes to the first provider that answers; the ones after it wait, highest priority first.'
            )}
          </p>
        </div>
        <Badge variant='outline'>
          {t('{{n}} name(s)', { n: props.names.length })}
        </Badge>
      </div>

      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
        <Stat label={t('Names')} value={props.names.length} />
        <Stat
          label={t('Served by more than one')}
          value={props.multi}
          tone='accent'
        />
        <Stat
          label={t('Nobody serving it')}
          value={props.orphaned}
          tone={props.orphaned > 0 ? 'bad' : 'plain'}
        />
      </div>

      <div className='relative max-w-sm'>
        <Search
          className='text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2'
          aria-hidden='true'
        />
        <Input
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder={t('Search names and providers')}
          aria-label={t('Search routes')}
          className='h-8 pl-7 text-xs'
        />
      </div>

      {list}

      <p className='text-muted-foreground flex items-center gap-1.5 text-[11px]'>
        <RadioTower className='size-3' aria-hidden='true' />
        {t(
          "Read from the relay's own abilities; it refreshes itself every 30 seconds."
        )}
      </p>
    </div>
  )
}

/** One number, said large, with what it counts under it. */
function Stat(props: {
  label: string
  value: number
  tone?: 'plain' | 'accent' | 'bad'
}) {
  return (
    <div className='bg-muted/30 rounded-md border px-2.5 py-2'>
      <div
        className={cn(
          'font-mono text-lg font-semibold tabular-nums',
          TONE[props.tone ?? 'plain']
        )}
      >
        {props.value}
      </div>
      <div className='text-muted-foreground mt-0.5 text-[10px]'>
        {props.label}
      </div>
    </div>
  )
}
