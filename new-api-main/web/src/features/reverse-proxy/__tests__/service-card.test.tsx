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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ServiceCard } from '../components/service-card'
import type { ReverseProxyService } from '../types'

function makeService(
  overrides: Partial<ReverseProxyService> = {}
): ReverseProxyService {
  return {
    id: 'workbuddy',
    name: 'WorkBuddy Free',
    enabled: true,
    workdir: 'C:\\hub\\workbuddy-free-main',
    command: './wb2api.exe -config config.json',
    manifest_path: 'C:\\hub\\new-api-main\\data\\reverse-proxy\\services\\workbuddy.json',
    host: '127.0.0.1',
    port: 7873,
    base_url: 'http://127.0.0.1:7873',
    health_path: '/healthz',
    panel_url: 'http://127.0.0.1:7873/panel/',
    panel_embed_url: '/api/reverse_proxy/panel/workbuddy/panel/',
    log_file: 'C:\\hub\\logs\\workbuddy.log',
    build_ready: true,
    key_masked: 'sk-x******4rb',
    channel: { registered: false },
    status: { running: true, healthy: true, pid: 4321, managed: false },
    ...overrides,
  }
}

const noopHandlers = {
  onAction: () => {},
  onShowLogs: () => {},
  onShowPanel: () => {},
  onShowKey: () => {},
}

describe('ServiceCard', () => {
  it('shows a running healthy service with stop and restart actions', () => {
    render(<ServiceCard service={makeService()} busy={false} {...noopHandlers} />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.getByText('4321')).toBeInTheDocument()
  })

  it('flags a running service whose health check fails', () => {
    render(
      <ServiceCard
        service={makeService({
          status: {
            running: true,
            healthy: false,
            pid: 4321,
            managed: true,
            detail: 'health check returned HTTP 502',
          },
        })}
        busy={false}
        {...noopHandlers}
      />
    )

    expect(screen.getByText('Unhealthy')).toBeInTheDocument()
    expect(screen.getByText('health check returned HTTP 502')).toBeInTheDocument()
  })

  it('offers start for a stopped service and reports the action', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    render(
      <ServiceCard
        service={makeService({
          status: {
            running: false,
            healthy: false,
            pid: 0,
            managed: false,
            detail: 'port 7873 is not listening',
          },
        })}
        busy={false}
        {...noopHandlers}
        onAction={onAction}
      />
    )

    expect(screen.getByText('Stopped')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(onAction).toHaveBeenCalledWith('start', 'workbuddy')
  })

  it('disables lifecycle actions for a disabled service', () => {
    render(
      <ServiceCard
        service={makeService({
          enabled: false,
          status: { running: false, healthy: false, pid: 0, managed: false },
        })}
        busy={false}
        {...noopHandlers}
      />
    )

    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  })

  it('reports stop and channel actions for a running service', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    render(
      <ServiceCard
        service={makeService()}
        busy={false}
        {...noopHandlers}
        onAction={onAction}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Register channel' }))
    expect(onAction).toHaveBeenNthCalledWith(1, 'stop', 'workbuddy')
    expect(onAction).toHaveBeenNthCalledWith(2, 'channel', 'workbuddy')
  })
})
