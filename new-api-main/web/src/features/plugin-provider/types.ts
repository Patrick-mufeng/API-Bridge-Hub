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
export type PluginHost = {
  enabled: boolean
  running: boolean
  config_dir: string
  auth_path: string
  list_path: string
  plugin_count: number
  bun_cached: boolean
  npm_registry: string
  china_mirror: boolean
}

export type PluginProviderOffer = {
  provider: string
  name: string
  signed_in: boolean
  models: string[]
  accounts: string[]
  tag?: string
}

export type PluginModel = {
  id: string
  /** What a client asks this hub for: the namespaced id, or the bare one. */
  relay_name?: string
  /** The thinking depths the vendor offers this model at ("low", "high"). */
  variants?: string[]
  /** What a request cost before the discount running now. */
  rate_was?: number
  /** The vendor serves it faster when asked to. */
  fast?: boolean
  /** The model searches the web by itself. */
  searches?: boolean
  name?: string
  context?: number
  output?: number
  free?: boolean
  rate?: number
  reasoning?: boolean
  image?: boolean
  price?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

export type QuotaWindow = {
  name: string
  used: number
  limit?: number
  amount?: number
  unit?: string
  display?: string
  resets_at?: string
  reset_secs?: number
}

export type PluginAccount = {
  key: string
  /** The models this account alone has, when the plugin splits the list. */
  models?: string[]
  type: string
  account_id?: string
  label: string
  enterprise?: string
  expires?: number
  needs_sign_in?: boolean
  /** The subscription card's name, when the vendor names one. */
  plan?: string
  /** The plugin's own word: kept, expired, or empty for nothing said. */
  sign_in?: string
  /** Why the plugin says the account is not usable. */
  error?: string
  /** The allowance windows its vendor counts against. */
  windows?: QuotaWindow[]
  /** Rate-limit resets the account may still spend. */
  resets?: number
  /** The channel it is a key of; 0 when not registered. */
  channel_id?: number
  /** Its place in that channel's key list; -1 when not pooled. */
  key_index?: number
  /** Whether that channel is serving requests now. */
  channel_on?: boolean
  /** Whether this account's own key is enabled in that channel's pool. */
  key_on?: boolean
}

/** One bare model id this hub serves, and who serves it first. */
export type BareRouteMember = {
  channel_id: number
  name: string
  priority: number
  weight: number
  enabled: boolean
  /**
   * The tier this member is in: the lowest rank answers first, and only a
   * failure moves the request on. Members sharing a rank are picked between
   * by weight — at equal weight, at random — so they are alternatives.
   */
  rank?: number
}

export type PluginMethod = {
  index: number
  type: 'oauth' | 'api'
  label: string
  placeholder?: string
  key_title?: string
  /** The method needs no key typed: authorize supplies the credential. */
  keyless?: boolean
}

export type PluginOption = {
  key: string
  label?: string
  description?: string
  labels?: Record<string, string>
  descriptions?: Record<string, string>
  value: boolean
  default: boolean
  filters_models?: boolean
  confirm?: string
}

export type PluginProviderDetail = {
  provider: string
  name: string
  /** The namespace its models are served under; empty when unnamespaced. */
  prefix?: string
  api_root?: string
  npm?: string
  signed_in: boolean
  accounts: PluginAccount[]
  methods: PluginMethod[]
  usage: boolean
  checkin: boolean
  renews: boolean
  /** The plugin could not reach its vendor and gave a default model list. */
  fell_back?: boolean
  list_error?: string
  /** The picture the plugin gives its provider: an https or data: URI. */
  icon?: string
  max_concurrency?: number
  max_accounts?: number
  models: PluginModel[]
  options?: PluginOption[]
}

export type InstalledPlugin = {
  spec: string
  name: string
  version?: string
  off: boolean
  providers?: string[]
  load_error?: string
  options?: Record<string, unknown>
  kind?: string
  update?: string
}

export type MarketPlugin = {
  package: string
  name: string
  icon?: string
  providers?: string[]
  community?: boolean
  replaces?: string
  kind?: string
  summary?: Record<string, string>
  version?: string
  description?: string
  publisher?: string
  license?: string
  homepage?: string
  repository?: string
  /** Downloads on npm last week, 0 when npm didn't say. */
  weekly?: number
  installed: boolean
  installed_version?: string
}

export type RegisterResult = {
  created?: ChannelView[]
  updated?: ChannelView[]
  skipped?: string[]
  /** Accounts the plugin reported as signed out; their channels are off. */
  lapsed?: string[]
  /** One line: how many accounts are usable. */
  health?: string
}

export type ChannelView = {
  id: number
  name: string
  account: string
  models: string[]
  tag: string
  is_update: boolean
}

export type SignInPrompt = {
  type: string
  key: string
  message: string
  placeholder?: string
  options?: { label: string; value: string; hint?: string }[]
}

export type SignInStart = {
  prompt?: SignInPrompt
  session?: string
  url?: string
  instructions?: string
  method?: string
  saved?: PluginAccount
}

export type ServerResponse<T> = {
  success: boolean
  message: string
  data?: T
}

/** One channel a provider is served by. */
export type ProviderChannel = {
  id: number
  name: string
  tag?: string
  prefix?: string
  models: number
  enabled: boolean
  priority: number
  weight: number
  /** How many accounts the channel pools. */
  keys?: number
}

/** One account's check-in, as the plugin's vendor answered. */
export type CheckinEntry = {
  account: string
  label?: string
  /** claimed, done, ineligible, inactive, captcha or failed. */
  outcome: string
  credit?: number
  streak?: number
  message?: string
  until?: string
  error?: string
}

export type CheckinResult = {
  provider: string
  accounts: CheckinEntry[]
  claimed: number
  failed: number
}

/** A provider's own page. */
export type AccountPage = {
  provider: string
  name: string
  api_root?: string
  npm?: string
  signed_in: boolean
  checkin: boolean
  usage: boolean
  renews: boolean
  accounts: PluginAccount[]
  channels?: ProviderChannel[]
}

/** The daily check-in: whether it runs by itself, and how it last went. */
export type CheckinSettings = {
  auto: boolean
  /** The hour of the local day it runs at, 0-23. */
  at: number
  keep_days: number
  last_run?: number
  last_said?: string
}

/** One account's remembered check-in, by local day. */
export type CheckinHistoryEntry = {
  account: string
  label?: string
  outcome: string
  credit?: number
  streak?: number
  message?: string
  day?: string
  error?: string
}

/** What came of asking for a sign-in to be renewed. */
export type RenewalRecord = {
  provider: string
  account: string
  renewed: boolean
  gone: boolean
  error?: string
  at: number
}

/** One bucket of a provider's spend: an hour, or a day. */
export type UsageWindow = {
  start: number
  requests: number
  prompt_tokens: number
  completion_tokens: number
  tokens: number
  quota: number
}

/** What one model of a provider cost in the period asked for. */
export type UsageModel = {
  model: string
  /** The id a client asks for without the namespace: glm-5.3 for wb:glm-5.3. */
  bare?: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  tokens: number
  quota: number
  seconds: number
  average: number
}

/** One account of a provider, and its share of the spend. */
export type UsageAccount = {
  account: string
  label?: string
  /** The channel it is served from; 0 when its accounts are pooled. */
  channel_id: number
  requests: number
  tokens: number
  quota: number
  on: boolean
}

/** One channel of a provider: the row a request through it lands on. */
export type UsageChannel = {
  id: number
  name: string
  tag?: string
  prefix?: string
  models: number
  enabled: boolean
  priority: number
  weight: number
  keys: number
  requests: number
  tokens: number
  quota: number
}

/** A provider's usage over one period. */
export type ProviderUsage = {
  provider: string
  name: string
  start: number
  end: number
  granularity: 'hour' | 'day'
  requests: number
  prompt_tokens: number
  completion_tokens: number
  tokens: number
  quota: number
  errors: number
  seconds: number
  average: number
  trend: UsageWindow[]
  models: UsageModel[]
  accounts: UsageAccount[]
  channels: UsageChannel[]
  serving: number
}

/** One request through a provider, as the live view plays it. */
export type ProviderRequest = {
  id: number
  created_at: number
  model_name: string
  channel_id: number
  username: string
  token_name: string
  prompt_tokens: number
  completion_tokens: number
  quota: number
  use_time: number
  is_stream: boolean
  /** LogTypeConsume for one that answered, LogTypeError for one that did not. */
  type: number
}

/** What taking an account out came to. */
export type RemovedAccount = {
  provider: string
  account: string
  /** The channels it was taken out of. */
  channels: number[]
  /** The channels that went with it: they had no account left to serve. */
  removed: number[]
  /** Whether the plugin's own record of the sign-in is gone too. */
  signed_out: boolean
}
