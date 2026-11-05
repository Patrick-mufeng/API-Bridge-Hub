import { ChevronDown } from 'lucide-react'
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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MOTION_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

import { memberTiers, type RouteGroup } from '../lib/routes'
import type { BareRouteMember } from '../types'

/**
 * One row of the map: the model names a client may ask for, and the
 * providers that answer them in the order they are tried.
 *
 * The order is the relay's own — highest priority first, weight breaking a
 * tie — so what this draws is what routing does. A provider that is switched
 * off is drawn struck through: the request never reaches it.
 */
export function RoutingRow(props: { group: RouteGroup; index: number }) {
  const { t } = useTranslation()
  const shouldReduce = useReducedMotion()
  const [open, setOpen] = useState(false)

  const members = props.group.members
  const live = members.filter((member) => member.enabled)
  // one provider needs no ordering marks: there is nothing after it
  const ordered = members.length > 1
  const tiers = memberTiers(members)

  return (
    <motion.div
      initial={shouldReduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        ...MOTION_TRANSITION.default,
        delay: Math.min(props.index * 0.04, 0.35),
      }}
      className='bg-card rounded-lg border px-3 py-2.5'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <NameCluster
          group={props.group}
          open={open}
          onToggle={() => setOpen((was) => !was)}
        />

        <span
          className='text-muted-foreground flex items-center'
          aria-hidden='true'
        >
          <FlowWire />
        </span>

        <span className='flex flex-wrap items-center gap-1.5'>
          {tiers.map((tier, tierIndex) => (
            <span
              key={tier.map((member) => member.channel_id).join('-')}
              className='flex items-center gap-1.5'
            >
              {tierIndex > 0 ? (
                <span
                  className='text-muted-foreground flex items-center'
                  aria-hidden='true'
                  title={t('a failed request falls through to this tier')}
                >
                  <FlowWire muted={tier.every((member) => !member.enabled)} />
                </span>
              ) : null}
              <span className='flex flex-wrap items-center gap-1'>
                {tier.map((member) => (
                  <MemberNode
                    key={member.channel_id}
                    member={member}
                    first
                    ordered={ordered}
                    alternatives={tier.length}
                  />
                ))}
              </span>
            </span>
          ))}
        </span>

        <span className='grow' />

        {live.length === 0 ? (
          <span className='text-destructive text-[10px] font-medium'>
            {t('Nobody serving it')}
          </span>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {open && props.group.names.length > 1 ? (
          <motion.div
            initial={shouldReduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={shouldReduce ? undefined : { height: 0, opacity: 0 }}
            transition={MOTION_TRANSITION.default}
            className='overflow-hidden'
          >
            <div className='mt-2 flex flex-wrap gap-1 border-t pt-2'>
              {props.group.names.map((name) => (
                <span
                  key={name}
                  className='bg-muted/50 rounded px-1.5 py-0.5 font-mono text-[10px]'
                >
                  {name}
                </span>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}

/** The names on the left: one, or a count that opens into all of them. */
function NameCluster(props: {
  group: RouteGroup
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const count = props.group.names.length

  if (count === 1) {
    return (
      <span className='min-w-0'>
        <span className='font-mono text-xs font-semibold'>
          {props.group.names[0]}
        </span>
      </span>
    )
  }

  return (
    <button
      type='button'
      onClick={props.onToggle}
      aria-expanded={props.open}
      className='focus-visible:ring-ring/50 flex min-w-0 items-center gap-1 rounded-md text-left outline-none focus-visible:ring-3'
    >
      <motion.span
        animate={{ rotate: props.open ? 0 : -90 }}
        transition={MOTION_TRANSITION.fast}
        className='text-muted-foreground inline-flex shrink-0'
        aria-hidden='true'
      >
        <ChevronDown className='size-3.5' />
      </motion.span>
      <span className='min-w-0'>
        <span className='block text-xs font-semibold'>
          {t('{{n}} model names', { n: count })}
        </span>
        <span className='text-muted-foreground block truncate font-mono text-[10px]'>
          {props.group.names.slice(0, 3).join(', ')}
          {count > 3 ? ` … +${count - 3}` : ''}
        </span>
      </span>
    </button>
  )
}

/** A provider in the chain: where a request for these names lands. */
function MemberNode(props: {
  member: BareRouteMember
  first: boolean
  ordered: boolean
  /** How many members share this tier: the relay picks between them. */
  alternatives?: number
}) {
  const { t } = useTranslation()
  const shouldReduce = useReducedMotion()

  return (
    <span
      className={cn(
        'relative inline-flex flex-col justify-center rounded-md border px-2 py-1 text-[11px] transition-colors',
        memberTone(props.member.enabled, props.first)
      )}
      title={t('priority {{p}}, weight {{w}}', {
        p: props.member.priority,
        w: props.member.weight,
      })}
    >
      <span
        className={cn(
          'max-w-40 truncate font-medium',
          !props.member.enabled && 'line-through'
        )}
      >
        {props.member.name}
      </span>
      {props.ordered ? (
        <span className='text-muted-foreground font-mono text-[10px]'>
          {props.first
            ? t('first')
            : t('priority {{p}}', { p: props.member.priority })}
        </span>
      ) : null}
      {props.first && !shouldReduce ? (
        <motion.span
          className='bg-primary absolute -top-1 -right-1 size-1.5 rounded-full'
          aria-hidden='true'
        >
          <motion.span
            className='bg-primary absolute inset-0 rounded-full'
            animate={{ scale: [1, 2.4, 1], opacity: [0.7, 0, 0.7] }}
            transition={{
              duration: 2.2,
              repeat: Number.POSITIVE_INFINITY,
              ease: 'easeInOut',
            }}
          />
        </motion.span>
      ) : null}
    </span>
  )
}

/** How a member is drawn: the one that answers first stands out. */
function memberTone(enabled: boolean, isFirst: boolean) {
  if (!enabled) {
    return 'text-muted-foreground bg-muted/20 border-dashed'
  }
  if (isFirst) {
    return 'border-primary/50 bg-primary/5'
  }
  return 'bg-muted/40'
}

/**
 * The wire a request crosses: a dot running along it, because that is what
 * a request for one of these names does. A wire into a provider that cannot
 * answer stays still.
 */
function FlowWire(props: { muted?: boolean }) {
  const shouldReduce = useReducedMotion()
  return (
    <svg
      viewBox='0 0 22 8'
      width='22'
      height='8'
      className={props.muted ? 'text-border' : 'text-primary/40'}
      aria-hidden='true'
    >
      <line
        x1='0'
        y1='4'
        x2='22'
        y2='4'
        stroke='currentColor'
        strokeWidth='1.5'
        strokeDasharray={props.muted ? '2 3' : undefined}
      />
      {props.muted || shouldReduce ? null : (
        <motion.circle
          cy='4'
          r='2'
          fill='currentColor'
          initial={{ cx: 1, opacity: 0 }}
          animate={{ cx: [1, 21], opacity: [0, 1, 0] }}
          transition={{
            duration: 1.6,
            repeat: Number.POSITIVE_INFINITY,
            ease: 'easeInOut',
            repeatDelay: 0.5,
            delay: 0.2,
          }}
        />
      )}
    </svg>
  )
}

/** The page's own empty state, drawn rather than written. */
export function RoutingEmpty() {
  const { t } = useTranslation()
  const shouldReduce = useReducedMotion()
  return (
    <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed py-12'>
      <motion.div
        initial={shouldReduce ? false : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={MOTION_TRANSITION.default}
        className='flex items-center gap-2'
      >
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className='bg-muted-foreground/40 size-1.5 rounded-full'
            animate={shouldReduce ? undefined : { opacity: [0.25, 1, 0.25] }}
            transition={{
              duration: 1.6,
              repeat: Number.POSITIVE_INFINITY,
              delay: i * 0.2,
              ease: 'easeInOut',
            }}
          />
        ))}
      </motion.div>
      <p className='text-sm font-medium'>{t('No model is routed yet.')}</p>
      <p className='text-muted-foreground max-w-md text-center text-xs'>
        {t(
          'Register a provider on the Services page; the models it serves become names of their own here.'
        )}
      </p>
    </div>
  )
}
