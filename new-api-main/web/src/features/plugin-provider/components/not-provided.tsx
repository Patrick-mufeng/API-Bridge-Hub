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
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * A capability the plugin did not declare.
 *
 * Every plugin is written to a contract that lets it declare what it can do —
 * usage, check-in, its own switches, a model list of its own. A page that
 * silently leaves the section out reads as a page that is broken or still
 * loading; saying "this plugin does not provide it" is the difference between
 * an absent feature and an unfinished one.
 *
 * The wording is the plugin's own: it did not declare the hook, so nothing
 * here is missing on the console's side and nothing is worth a warning.
 */
export function NotProvided(props: {
  /** What is absent, as the console calls it ("Usage"). */
  what: string
  /** The hook the plugin would have to declare, when it has a name. */
  hook?: string
  detail?: string
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-1 rounded-md border border-dashed px-2.5 py-2',
        props.className
      )}
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <Badge variant='outline' className='text-[10px]'>
          {props.what}
        </Badge>
        <span className='text-muted-foreground text-xs'>
          {props.detail || t('This plugin does not provide it')}
        </span>
      </div>
      {props.hook ? (
        <code className='text-muted-foreground bg-muted/50 rounded px-1 py-0.5 text-[10px]'>
          {props.hook}
        </code>
      ) : null}
    </div>
  )
}
