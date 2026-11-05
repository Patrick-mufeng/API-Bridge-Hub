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
import { ArrowDownUp, Search, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { formatCompactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { PluginModel } from '../types'

/** The columns the table is sorted by, and what each one counts. */
const SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'context', label: 'Context' },
  { id: 'output', label: 'Max output' },
  { id: 'rate', label: 'Credits' },
] as const

type SortId = (typeof SORTS)[number]['id']

/**
 * The models a provider serves, one row each, with what tells them apart:
 * the name a client asks for, the thinking depths it takes, what a request
 * costs, and how much it holds and answers.
 *
 * A list rather than a cloud of badges because these are the numbers an
 * operator picks a model by — "which is cheapest", "which holds the most" —
 * and a badge shows none of them. A value the plugin did not say is left
 * blank rather than printed as zero: nought tokens of context is a fact
 * about a model, and one nobody stated is not.
 */
export function ModelTable(props: { models: PluginModel[] }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortId>('name')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const kept = q
      ? props.models.filter(
          (model) =>
            model.id.toLowerCase().includes(q) ||
            (model.relay_name || '').toLowerCase().includes(q) ||
            (model.name || '').toLowerCase().includes(q) ||
            (model.variants || []).some((v) => v.toLowerCase().includes(q))
        )
      : [...props.models]
    kept.sort((a, b) => compare(a, b, sort))
    return kept
  }, [props.models, query, sort])

  if (props.models.length === 0) {
    return (
      <p className='text-muted-foreground rounded-md border px-2.5 py-2 text-xs'>
        {t('This provider lists no model yet.')}
      </p>
    )
  }

  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <div className='relative min-w-0 flex-1'>
          <Search
            className='text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2'
            aria-hidden='true'
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search models')}
            aria-label={t('Search models')}
            className='h-7 pl-7 text-xs'
          />
        </div>
        <div className='flex items-center gap-0.5'>
          <ArrowDownUp
            className='text-muted-foreground size-3'
            aria-hidden='true'
          />
          {SORTS.map((item) => (
            <button
              key={item.id}
              type='button'
              onClick={() => setSort(item.id)}
              aria-pressed={sort === item.id}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                sort === item.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>

      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full text-[11px]'>
          <thead>
            <tr className='bg-muted/40 text-muted-foreground text-left'>
              <Th>{t('Model')}</Th>
              <Th>{t('Thinking')}</Th>
              <Th className='text-right'>{t('Credits')}</Th>
              <Th className='text-right'>{t('Context')}</Th>
              <Th className='text-right'>{t('Max output')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className='text-muted-foreground py-3 text-center text-xs'>
          {t('Nothing matches.')}
        </p>
      ) : null}

      <p className='text-muted-foreground text-[10px]'>
        {t(
          'The name a client asks for is the one in the Model column. A blank cell is a value the plugin did not state.'
        )}
      </p>
    </div>
  )
}

/** One model. */
function ModelRow(props: { model: PluginModel }) {
  const { t } = useTranslation()
  const model = props.model
  const variants = model.variants ?? []

  return (
    <tr className='border-t'>
      <td className='px-2 py-1'>
        <div className='flex flex-wrap items-center gap-1'>
          <span className='font-mono font-medium'>
            {model.relay_name || model.id}
          </span>
          {model.free ? (
            <Badge
              variant='outline'
              className='border-emerald-500/40 text-[9px] text-emerald-600'
            >
              <Sparkles className='mr-0.5 size-2' aria-hidden='true' />
              {t('Free')}
            </Badge>
          ) : null}
          {model.reasoning ? (
            <Badge variant='secondary' className='text-[9px]'>
              {t('Reasoning')}
            </Badge>
          ) : null}
        </div>
        {model.name && model.name !== (model.relay_name || model.id) ? (
          <div className='text-muted-foreground text-[10px]'>{model.name}</div>
        ) : null}
      </td>
      <td className='px-2 py-1'>
        {variants.length === 0 ? (
          <span className='text-muted-foreground'>{t('none')}</span>
        ) : (
          <span className='flex flex-wrap gap-0.5'>
            {variants.map((variant) => (
              <span
                key={variant}
                className='bg-muted rounded px-1 py-0.5 font-mono text-[9px]'
              >
                {variant}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className='px-2 py-1 text-right font-mono'>
        <Rate model={model} />
      </td>
      <td className='px-2 py-1 text-right font-mono'>
        {model.context ? formatCompactNumber(model.context) : ''}
      </td>
      <td className='px-2 py-1 text-right font-mono'>
        {model.output ? formatCompactNumber(model.output) : ''}
      </td>
    </tr>
  )
}

/** What a request costs: the multiplier, and the price it was cut from. */
function Rate(props: { model: PluginModel }) {
  const { t } = useTranslation()
  if (props.model.free) {
    return <span className='text-emerald-600'>x0</span>
  }
  if (!props.model.rate) {
    if (
      props.model.price &&
      (props.model.price.input > 0 || props.model.price.output > 0)
    ) {
      return (
        <span title={t('price per million tokens')}>
          {props.model.price.input}/{props.model.price.output}
        </span>
      )
    }
    // the vendor lists the price on a page, not in the plugin's numbers
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <span>
      x{props.model.rate}
      {props.model.rate_was ? (
        <span className='text-muted-foreground ml-1 line-through'>
          x{props.model.rate_was}
        </span>
      ) : null}
    </span>
  )
}

function Th(props: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-2 py-1 font-medium', props.className)}>
      {props.children}
    </th>
  )
}

/** Orders two models by one column; a value nobody stated sorts last. */
function compare(a: PluginModel, b: PluginModel, sort: SortId): number {
  if (sort === 'name') {
    return (a.relay_name || a.id).localeCompare(b.relay_name || b.id)
  }
  const of = (model: PluginModel) => {
    if (sort === 'context') {
      return model.context ?? 0
    }
    if (sort === 'output') {
      return model.output ?? 0
    }
    return model.free ? 0 : (model.rate ?? 0)
  }
  return of(b) - of(a)
}
