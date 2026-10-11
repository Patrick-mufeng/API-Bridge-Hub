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
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { SectionPageLayout } from '@/components/layout'
import { SettingsPageProvider } from '@/features/system-settings/components/settings-page-context'
import {
  getOptionValue,
  useSystemOptions,
} from '@/features/system-settings/hooks/use-system-options'
import {
  parseHeaderNavModules,
  parseSidebarModulesAdmin,
} from '@/features/system-settings/maintenance/config'
import { HeaderNavigationSection } from '@/features/system-settings/maintenance/header-navigation-section'
import { SidebarModulesSection } from '@/features/system-settings/maintenance/sidebar-modules-section'
import type { SystemOption } from '@/features/system-settings/types'

import { FeatureTogglesSection } from './feature-toggles-section'

const FEATURE_OPTION_DEFAULTS = {
  HeaderNavModules: '',
  SidebarModulesAdmin: '',
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const [actionsContainer, setActionsContainer] =
    useState<HTMLDivElement | null>(null)

  return (
    <div className='bg-card text-card-foreground rounded-xl border shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3'>
        <div className='flex flex-col gap-0.5'>
          <h3 className='text-sm leading-none font-semibold'>{title}</h3>
          {description && (
            <p className='text-muted-foreground text-xs'>{description}</p>
          )}
        </div>
        <div
          ref={setActionsContainer}
          className='flex flex-wrap items-center justify-end gap-2'
        />
      </div>
      <div className='p-4'>
        <SettingsPageProvider actionsContainer={actionsContainer}>
          {children}
        </SettingsPageProvider>
      </div>
    </div>
  )
}

const findOptionRaw = (
  options: SystemOption[] | undefined,
  key: string
): string => options?.find((option) => option.key === key)?.value ?? ''

export function FeatureConfig() {
  const { t } = useTranslation()
  const { data, isLoading, isError, refetch } = useSystemOptions()

  const headerNavRaw = findOptionRaw(data?.data, 'HeaderNavModules')
  const sidebarRaw = findOptionRaw(data?.data, 'SidebarModulesAdmin')
  const headerNavConfig = useMemo(
    () => parseHeaderNavModules(headerNavRaw),
    [headerNavRaw]
  )
  const sidebarConfig = useMemo(
    () => parseSidebarModulesAdmin(sidebarRaw),
    [sidebarRaw]
  )
  const optionDefaults = useMemo(
    () =>
      getOptionValue(data?.data, FEATURE_OPTION_DEFAULTS),
    [data?.data]
  )

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex max-w-full min-w-0 items-center gap-2 align-middle'>
          <span className='truncate'>{t('Feature Config')}</span>
          <Badge variant='outline'>{t('Admin')}</Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <div className='flex flex-wrap items-center justify-end gap-2' />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {isLoading ? (
          <div className='text-muted-foreground flex min-h-40 items-center justify-center text-sm'>
            {t('Loading settings...')}
          </div>
        ) : isError && !data ? (
          <ErrorState title={t('Failed to load settings')} onRetry={() => void refetch()} />
        ) : (
          <div className='flex h-full min-h-0 w-full flex-col gap-4'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Toggle product modules on demand. Hidden entries disappear from the navigation for every user, and public pages are additionally blocked server-side.'
              )}
            </p>

            <SectionCard
              title={t('Feature switches')}
              description={t(
                'Master switches for registration, check-in, drawing, tasks and console panels.'
              )}
            >
              <FeatureTogglesSection options={data?.data} />
            </SectionCard>

            <SectionCard
              title={t('Header navigation')}
              description={t(
                'Top navigation entries. Model Square and Rankings are also enforced by the backend.'
              )}
            >
              <HeaderNavigationSection
                config={headerNavConfig}
                initialSerialized={optionDefaults.HeaderNavModules}
              />
            </SectionCard>

            <SectionCard
              title={t('Sidebar modules')}
              description={t(
                'Sidebar pages per area. Disabling a page hides it for every user.'
              )}
            >
              <SidebarModulesSection
                config={sidebarConfig}
                initialSerialized={optionDefaults.SidebarModulesAdmin}
              />
            </SectionCard>
          </div>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
