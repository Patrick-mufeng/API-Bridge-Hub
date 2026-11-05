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

import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { HostCard } from './components/host-card'
import { PluginsPanel } from './components/plugins-panel'
import { ProvidersPanel } from './components/providers-panel'

/**
 * Plugins: the market of community packages, laid out as magpie lays it
 * out. Discover and Installed are the two tabs; Providers is where a
 * subscription is signed in to and registered as channels, which is the
 * step that makes the relay able to serve it.
 */
export function PluginsPage() {
  const { t } = useTranslation()

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex min-w-0 items-center gap-2'>
          <span className='truncate'>{t('Plugins')}</span>
          <Badge variant='outline' className='shrink-0'>
            {t('Admin')}
          </Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <HostCard />
          <Tabs defaultValue='providers'>
            <TabsList>
              <TabsTrigger value='providers'>{t('Providers')}</TabsTrigger>
              <TabsTrigger value='plugins'>{t('Plugins')}</TabsTrigger>
            </TabsList>
            <TabsContent value='providers' className='mt-3'>
              <ProvidersPanel />
            </TabsContent>
            <TabsContent value='plugins' className='mt-3'>
              <PluginsPanel />
            </TabsContent>
          </Tabs>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
