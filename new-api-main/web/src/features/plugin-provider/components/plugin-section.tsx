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

import type { MarketPlugin } from '../types'
import { PluginCard } from './plugin-card'

/**
 * One kind of plugin, as magpie groups them: Subscriptions (what the relay
 * can serve), Gateway middleware, Agents, Tools, Pages. The heading says
 * what the kind is for rather than what it is called.
 */
export function PluginSection({
  title,
  hint,
  plugins,
  onOpen,
}: {
  title: string
  hint: string
  plugins: MarketPlugin[]
  onOpen: (plugin: MarketPlugin) => void
}) {
  if (plugins.length === 0) {
    return null
  }
  return (
    <section className='space-y-2'>
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        <span className='text-muted-foreground text-xs'>{hint}</span>
      </div>
      <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.package}
            plugin={plugin}
            onOpen={() => onOpen(plugin)}
          />
        ))}
      </div>
    </section>
  )
}
