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

import { api } from '@/lib/api'

import type {
  AccountPage,
  CheckinSettings,
  CheckinHistoryEntry,
  RenewalRecord,
  BareRouteMember,
  CheckinResult,
  InstalledPlugin,
  MarketPlugin,
  PluginHost,
  PluginProviderDetail,
  PluginProviderOffer,
  ProviderRequest,
  ProviderUsage,
  RemovedAccount,
  RegisterResult,
  ServerResponse,
  SignInStart,
} from './types'

export async function listPluginHost() {
  const res = await api.get<ServerResponse<PluginHost>>(
    '/api/plugin_provider/host'
  )
  return res.data
}

export async function updatePluginHost(input: {
  enabled?: boolean
  npm_registry?: string
  china_mirror?: boolean
}) {
  const res = await api.put<ServerResponse<PluginHost>>(
    '/api/plugin_provider/host',
    input
  )
  return res.data
}

export async function listPluginProviders() {
  const res = await api.get<
    ServerResponse<{ providers: PluginProviderOffer[]; host: PluginHost }>
  >('/api/plugin_provider/providers')
  return res.data
}

export async function getPluginProvider(id: string) {
  const res = await api.get<ServerResponse<PluginProviderDetail>>(
    `/api/plugin_provider/providers/${encodeURIComponent(id)}`
  )
  return res.data
}

export async function registerPluginProvider(input: {
  provider: string
  accounts?: string[]
  model_prefix?: string
  group?: string
  name?: string
  /**
   * One channel per account instead of one that pools them. Left out, the
   * provider is registered as a single channel whose keys are its accounts,
   * which the plugin and the relay both rotate.
   */
  per_account?: boolean
}) {
  const res = await api.post<ServerResponse<RegisterResult>>(
    '/api/plugin_provider/register',
    input
  )
  return res.data
}

export async function listInstalledPlugins() {
  const res = await api.get<
    ServerResponse<{ plugins: InstalledPlugin[]; host: PluginHost }>
  >('/api/plugin_provider/plugins')
  return res.data
}

export async function installPlugin(spec: string) {
  const res = await api.post<ServerResponse<InstalledPlugin>>(
    '/api/plugin_provider/plugins',
    { spec }
  )
  return res.data
}

export async function uninstallPlugin(spec: string) {
  const res = await api.delete<ServerResponse<null>>(
    '/api/plugin_provider/plugins',
    { params: { spec } }
  )
  return res.data
}

export async function setPluginOff(spec: string, off: boolean) {
  const res = await api.post<ServerResponse<null>>(
    '/api/plugin_provider/plugins/off',
    { off },
    { params: { spec } }
  )
  return res.data
}

export async function upgradePlugins(spec?: string) {
  const res = await api.post<ServerResponse<null>>(
    '/api/plugin_provider/upgrade',
    {
      spec: spec ?? '',
    }
  )
  return res.data
}

export async function listPluginMarket() {
  const res = await api.get<ServerResponse<{ plugins: MarketPlugin[] }>>(
    '/api/plugin_provider/market'
  )
  return res.data
}

export async function searchPluginMarket(q: string) {
  const res = await api.get<ServerResponse<{ plugins: MarketPlugin[] }>>(
    '/api/plugin_provider/market/search',
    { params: { q } }
  )
  return res.data
}

export async function startPluginSignIn(input: {
  provider: string
  method: number
  inputs?: Record<string, string>
  account?: string
}) {
  const res = await api.post<ServerResponse<SignInStart>>(
    '/api/plugin_provider/signin/start',
    input
  )
  return res.data
}

export async function pluginSignInKey(input: {
  provider: string
  method: number
  inputs?: Record<string, string>
  key: string
  account?: string
}) {
  const res = await api.post<ServerResponse<{ key: string; label: string }>>(
    '/api/plugin_provider/signin/key',
    input
  )
  return res.data
}

export async function pollPluginSignIn(provider: string, session: string) {
  const res = await api.post<
    ServerResponse<{ done: boolean; account?: { key: string; label: string } }>
  >('/api/plugin_provider/signin/poll', { provider, session })
  return res.data
}

/**
 * Take one account out: its place in every channel that serves it, then the
 * plugin's own record of its sign-in. What came of the channels is returned,
 * so the console can say whether a row went with it.
 */
export async function removePluginAccount(provider: string, account: string) {
  const res = await api.post<ServerResponse<RemovedAccount>>(
    '/api/plugin_provider/signout',
    { provider, account }
  )
  return res.data
}

export async function setPluginProviderOption(
  provider: string,
  key: string,
  on: boolean
) {
  const res = await api.post<ServerResponse<null>>(
    '/api/plugin_provider/option',
    {
      provider,
      key,
      on,
    }
  )
  return res.data
}

export type AccountHealth = {
  provider: string
  account: string
  channel_id: number
  sign_in?: string
  error?: string
  healthy: boolean
  channel_on: boolean
  changed: boolean
  plan?: string
  windows?: {
    name: string
    used?: number
    limit?: number
    display?: string
    unit?: string
    resets_at?: string
  }[]
}

export async function syncPluginHealth(provider?: string) {
  const res = await api.post<
    ServerResponse<{ accounts: AccountHealth[]; summary: string }>
  >(
    '/api/plugin_provider/health/sync',
    {},
    { params: provider ? { provider } : {} }
  )
  return res.data
}

export async function listPluginRoutes() {
  const res = await api.get<
    ServerResponse<{ routes: Record<string, BareRouteMember[]> }>
  >('/api/plugin_provider/routes')
  return res.data
}

export async function getPluginProviderPage(provider: string) {
  const res = await api.get<ServerResponse<AccountPage>>(
    `/api/plugin_provider/providers/${encodeURIComponent(provider)}/page`
  )
  return res.data
}

export async function checkinPluginProvider(
  provider: string,
  account?: string
) {
  const res = await api.post<ServerResponse<CheckinResult>>(
    '/api/plugin_provider/checkin',
    { provider, account: account ?? '' }
  )
  return res.data
}

export async function getCheckinOptions() {
  const res = await api.get<
    ServerResponse<{
      settings: CheckinSettings
      history: Record<string, CheckinHistoryEntry>
    }>
  >('/api/plugin_provider/checkin/options')
  return res.data
}

export async function setCheckinOptions(input: {
  auto?: boolean
  at?: number
}) {
  const res = await api.put<ServerResponse<CheckinSettings>>(
    '/api/plugin_provider/checkin/options',
    input
  )
  return res.data
}

export async function runCheckinNow() {
  const res = await api.post<ServerResponse<CheckinResult>>(
    '/api/plugin_provider/checkin/run'
  )
  return res.data
}

export async function listRenewals() {
  const res = await api.get<ServerResponse<{ renewals: RenewalRecord[] }>>(
    '/api/plugin_provider/renewals'
  )
  return res.data
}

/** One provider's usage over a period: totals, trend, and the splits. */
export async function getPluginProviderUsage(
  provider: string,
  params: {
    start_timestamp: number
    end_timestamp: number
    granularity?: 'hour' | 'day'
  }
) {
  const res = await api.get<ServerResponse<ProviderUsage>>(
    `/api/plugin_provider/providers/${encodeURIComponent(provider)}/usage`,
    { params }
  )
  return res.data
}

/** The last requests through a provider, newest first. */
export async function getPluginProviderRequests(provider: string, limit = 40) {
  const res = await api.get<ServerResponse<{ requests: ProviderRequest[] }>>(
    `/api/plugin_provider/providers/${encodeURIComponent(provider)}/requests`,
    { params: { limit } }
  )
  return res.data
}

/**
 * Rename the models of every plugin channel to the namespaced form
 * ("wb-glm-5.3"), keeping the old names as bare aliases. With dry it reports
 * what it would do and writes nothing.
 */
export async function migratePluginPrefixes(dry = false) {
  const res = await api.post<
    ServerResponse<{
      dry: boolean
      migrated: {
        channel_id: number
        name: string
        from: string
        to: string
        models: number
        kept?: string[]
      }[]
      skipped?: string[]
    }>
  >('/api/plugin_provider/migrate-prefixes', null, {
    params: dry ? { dry: 1 } : {},
  })
  return res.data
}
