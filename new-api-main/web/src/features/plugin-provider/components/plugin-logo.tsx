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

import { Bot, FileCode2, Plug, Puzzle, Wrench } from 'lucide-react'

/**
 * The pictures magpie ships as png rather than svg. The names come from the
 * same set, copied beside these components; a name not in here is an svg.
 */
const PNG_ICONS = new Set([
  'alma',
  'app-alma',
  'app-cc-switch',
  'apple-touch-icon',
  'atomcode',
  'cindy',
  'crush',
  'hanako',
  'icon-512',
  'kimi-code-desktop',
  'lody',
  'mlx-serve',
  'mothx',
  'rtk',
  'snow',
  'typesafe',
  'zcode',
  'zoo-code',
])

/** The picture magpie draws for each kind, when a package gives none. */
const KIND_GLYPH: Record<string, typeof Plug> = {
  middleware: Plug,
  agent: Bot,
  tools: Wrench,
  page: FileCode2,
}

/**
 * A plugin's picture, as magpie shows one: its own icon when it has one,
 * and a glyph for its kind when it doesn't. The names come from the
 * community list and are files under /plugin-icons, the same pictures
 * magpie ships.
 */
/**
 * magpie's rule: an icon is a name of one of its own pictures, never a URL.
 * npm returns whatever a package put in its `icon` field, which is
 * sometimes a full address; drawing that would fetch a stranger's server
 * from every card, and it 404s when it's gone. A name with a scheme or a
 * slash in it is not one of ours, so the kind's glyph stands in.
 */
function isIconName(name: string) {
  return !/[:/\\]/.test(name)
}

export function PluginLogo({
  name,
  kind,
  size = 'md',
}: {
  name?: string
  kind?: string
  size?: 'md' | 'lg'
}) {
  const usable = name && isIconName(name) ? name : undefined
  const box = size === 'lg' ? 'size-9 rounded-md' : 'size-7 rounded-md'
  const iconSize = size === 'lg' ? 'size-5' : 'size-4'

  if (usable) {
    // a name is a file base: zcode is a png, the rest are svg
    const ext = PNG_ICONS.has(usable) ? 'png' : 'svg'
    return (
      <span
        className={`bg-muted/60 inline-flex shrink-0 items-center justify-center ${box}`}
      >
        <img
          src={`/plugin-icons/${usable}.${ext}`}
          alt=''
          aria-hidden='true'
          draggable={false}
          loading='lazy'
          className={`${iconSize} object-contain`}
        />
      </span>
    )
  }

  const Glyph = KIND_GLYPH[kind ?? ''] ?? Puzzle
  return (
    <span
      className={`bg-muted/60 text-muted-foreground inline-flex shrink-0 items-center justify-center ${box}`}
    >
      <Glyph className={iconSize} aria-hidden='true' />
    </span>
  )
}
