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
import type { BareRouteMember } from '../types'

/** Model names that reach exactly the same providers, in the same order. */
export type RouteGroup = {
  /** The member set, as a key: two names share a row when it is equal. */
  key: string
  names: string[]
  members: BareRouteMember[]
}

/**
 * Group the names by who serves them.
 *
 * Seventeen model names that all reach one channel are one fact, not
 * seventeen: drawn a row each, a map of this hub is a wall of identical
 * rows. A name that reaches a different set — a second provider as a
 * fallback, or nobody at all — is a different fact and gets its own row.
 */
export function groupRoutes(
  routes: Record<string, BareRouteMember[]>
): RouteGroup[] {
  const byKey = new Map<string, RouteGroup>()
  for (const name of Object.keys(routes).sort()) {
    const members = routes[name] ?? []
    const key = memberKey(members)
    const group = byKey.get(key)
    if (group) {
      group.names.push(name)
      continue
    }
    byKey.set(key, { key, names: [name], members })
  }
  // the groups serving the most names first: those are what this hub is
  return [...byKey.values()].sort((a, b) => b.names.length - a.names.length)
}

/**
 * What tells two names apart as a routing fact: which providers serve them,
 * and in what relation.
 *
 * A member's tier decides whether a request moves on to the next one, so the
 * key carries the rank rather than the bare order: two channels that tie on
 * priority are equally good and the relay picks between them at random, which
 * is the same fact whichever way round they are listed.
 */
export function memberKey(members: BareRouteMember[]): string {
  return members
    .map((member) => `${member.channel_id}@${member.rank ?? 0}`)
    .sort()
    .join(',')
}

/** The members of one row, grouped into the tiers a request is tried in. */
export function memberTiers(members: BareRouteMember[]): BareRouteMember[][] {
  const tiers: BareRouteMember[][] = []
  for (const member of members) {
    const rank = member.rank ?? 0
    if (tiers[rank]) {
      tiers[rank].push(member)
      continue
    }
    tiers[rank] = [member]
  }
  return tiers.filter((tier) => tier.length > 0)
}
