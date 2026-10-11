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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Logo } from '@/assets/logo'
import { getUserModels } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

// The reverse-proxy services behind this relay. Keep in sync with
// data/reverse-proxy/services/*.json manifests.
const RELAY_CHANNELS = [
  { name: 'WorkBuddy', prefix: 'wb:' },
  { name: 'Qoder', prefix: 'qd:' },
  { name: 'Cline', prefix: 'cl:' },
  { name: 'OpenCodeZ', prefix: 'ocz:' },
  { name: 'Trae', prefix: 'tr:' },
  { name: 'CmdGo', prefix: 'cg:' },
]

// Node positions in the 0-100 diagram space (three per side, flanking the hub).
const NODE_POSITIONS = [
  { x: 15, y: 16 },
  { x: 15, y: 50 },
  { x: 15, y: 84 },
  { x: 85, y: 16 },
  { x: 85, y: 50 },
  { x: 85, y: 84 },
]

export function HubDiagram() {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((state) => !!state.auth.user)

  const modelsQuery = useQuery({
    queryKey: ['home', 'user-models'],
    queryFn: async () => requireServerSuccess(await getUserModels()),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const countsByPrefix = useMemo(() => {
    const models = modelsQuery.data?.data ?? []
    const counts: Record<string, number> = {}
    for (const model of models) {
      const channel = RELAY_CHANNELS.find((ch) => model.startsWith(ch.prefix))
      if (channel) counts[channel.prefix] = (counts[channel.prefix] ?? 0) + 1
    }
    return counts
  }, [modelsQuery.data])

  const renderPill = (channel: (typeof RELAY_CHANNELS)[number]) => (
    <span
      key={channel.prefix}
      className='border-border/70 bg-card/90 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm'
    >
      <span className='text-foreground/85 font-medium'>{channel.name}</span>
      <span className='text-muted-foreground font-mono'>{channel.prefix}</span>
      {isAuthenticated && countsByPrefix[channel.prefix] !== undefined && (
        <span className='bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium'>
          {countsByPrefix[channel.prefix]}
        </span>
      )}
    </span>
  )

  return (
    <div className='relative z-10 px-6'>
      <div className='mx-auto max-w-4xl'>
        {/* Desktop: hub-and-spoke stage */}
        <div className='relative hidden h-[320px] md:block'>
          <svg
            aria-hidden
            className='text-border absolute inset-0 h-full w-full'
            viewBox='0 0 100 100'
            preserveAspectRatio='none'
          >
            {NODE_POSITIONS.map((pos) => {
              const cx1 = 50 + (pos.x - 50) * 0.12
              const cx2 = 50 + (pos.x - 50) * 0.62
              return (
                <path
                  key={`${pos.x}-${pos.y}`}
                  d={`M 50 50 C ${cx1} 50, ${cx2} ${pos.y}, ${pos.x} ${pos.y}`}
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='1.5'
                  vectorEffect='non-scaling-stroke'
                  strokeDasharray='3 4'
                  className='hub-line'
                />
              )
            })}
          </svg>

          {/* hub node */}
          <div className='absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'>
            <div className='relative flex flex-col items-center'>
              <div className='bg-card relative flex size-20 items-center justify-center rounded-2xl border shadow-lg shadow-blue-500/10'>
                <span
                  aria-hidden
                  className='absolute inline-flex size-20 animate-ping rounded-2xl bg-blue-500/10'
                />
                <Logo className='text-primary relative size-9' />
              </div>
              <span className='text-muted-foreground mt-2.5 font-mono text-[11px]'>
                BridgeHub · /v1
              </span>
            </div>
          </div>

          {/* channel nodes */}
          {RELAY_CHANNELS.map((channel, index) => {
            const pos = NODE_POSITIONS[index]
            return (
              <div
                key={channel.prefix}
                className='absolute -translate-x-1/2 -translate-y-1/2'
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              >
                {renderPill(channel)}
              </div>
            )
          })}
        </div>

        {/* Mobile: plain wrap */}
        <div className='mt-6 flex flex-wrap justify-center gap-2 md:hidden'>
          {RELAY_CHANNELS.map(renderPill)}
        </div>

        <style>{`
          .hub-line { animation: hub-dash 1.4s linear infinite; }
          @keyframes hub-dash { to { stroke-dashoffset: -14; } }
        `}</style>
      </div>
    </div>
  )
}
