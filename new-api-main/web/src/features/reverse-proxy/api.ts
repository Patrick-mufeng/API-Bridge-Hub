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
  ReverseProxyActionPayload,
  ReverseProxyServicesPayload,
  ServerResponse,
} from './types'

export async function listReverseProxyServices() {
  const res = await api.get<ServerResponse<ReverseProxyServicesPayload>>(
    '/api/reverse_proxy/services'
  )
  return res.data
}

export async function reloadReverseProxyServices() {
  const res = await api.post<ServerResponse<ReverseProxyServicesPayload>>(
    '/api/reverse_proxy/services/reload'
  )
  return res.data
}

export async function startReverseProxyService(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/start`
  )
  return res.data
}

export async function stopReverseProxyService(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/stop`
  )
  return res.data
}

export async function restartReverseProxyService(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/restart`
  )
  return res.data
}

export async function buildReverseProxyService(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/build`
  )
  return res.data
}

export async function registerReverseProxyChannel(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/channel`
  )
  return res.data
}

export async function getReverseProxyServiceLogs(id: string, lines = 200) {
  const res = await api.get<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/logs`,
    { params: { lines } }
  )
  return res.data
}

export async function revealReverseProxyServiceKey(id: string) {
  const res = await api.get<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/key`
  )
  return res.data
}

export async function createReverseProxyPanelTicket(id: string) {
  const res = await api.post<ServerResponse<ReverseProxyActionPayload>>(
    `/api/reverse_proxy/services/${encodeURIComponent(id)}/panel_ticket`
  )
  return res.data
}
