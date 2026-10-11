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
export type ReverseProxyRuntimeStatus = {
  running: boolean
  healthy: boolean
  pid: number
  managed: boolean
  detail?: string
}

export type ReverseProxyChannel = {
  registered: boolean
  id?: number
  name?: string
  status?: number
  models?: number
}

export type ReverseProxyService = {
  id: string
  name: string
  description?: string
  enabled: boolean
  workdir: string
  command: string
  manifest_path: string
  host: string
  port: number
  base_url: string
  health_path?: string
  panel_url?: string
  panel_embed_url?: string
  log_file: string
  build_ready: boolean
  model_prefix?: string
  priority?: number
  weight?: number
  key_masked?: string
  key_error?: string
  channel: ReverseProxyChannel
  status: ReverseProxyRuntimeStatus
}

export type ReverseProxyServicesPayload = {
  hub_root: string
  services_dir: string
  load_errors: string[] | null
  services: ReverseProxyService[]
}

export type ReverseProxyActionPayload = {
  service?: ReverseProxyService
  output?: string
  channel?: ReverseProxyChannel
  models?: string[]
  log?: string
  key?: string
  embed_url?: string
}

export type ServerResponse<T> = {
  success: boolean
  message: string
  data?: T
}
