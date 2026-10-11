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
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  SettingsControlChildren,
  SettingsControlGroup,
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '@/features/system-settings/components/settings-form-layout'
import { SettingsPageFormActions } from '@/features/system-settings/components/settings-page-context'
import { useUpdateOption } from '@/features/system-settings/hooks/use-update-option'
import {
  getOptionValue,
} from '@/features/system-settings/hooks/use-system-options'
import type { SystemOption } from '@/features/system-settings/types'

const FEATURE_DEFAULTS = {
  SelfUseModeEnabled: false,
  RegisterEnabled: true,
  PasswordRegisterEnabled: true,
  DrawingEnabled: false,
  TaskEnabled: false,
  'checkin_setting.enabled': false,
  'console_setting.announcements_enabled': false,
  'console_setting.faq_enabled': false,
  'console_setting.api_info_enabled': false,
  'console_setting.uptime_kuma_enabled': false,
  QuotaForInviter: 0,
  QuotaForInvitee: 0,
}

const featureSchema = z.object({
  selfUseMode: z.boolean(),
  register: z.boolean(),
  drawing: z.boolean(),
  task: z.boolean(),
  checkin: z.boolean(),
  announcements: z.boolean(),
  faq: z.boolean(),
  apiInfo: z.boolean(),
  uptimeKuma: z.boolean(),
  affEnabled: z.boolean(),
  affInviter: z.number().int().min(0),
  affInvitee: z.number().int().min(0),
})

type FeatureFormValues = z.infer<typeof featureSchema>

type FeatureToggleMeta = {
  key: keyof FeatureFormValues
  title: string
  description: string
}

const toFormValues = (settings: typeof FEATURE_DEFAULTS): FeatureFormValues => ({
  selfUseMode: Boolean(settings.SelfUseModeEnabled),
  register: Boolean(settings.RegisterEnabled && settings.PasswordRegisterEnabled),
  drawing: Boolean(settings.DrawingEnabled),
  task: Boolean(settings.TaskEnabled),
  checkin: Boolean(settings['checkin_setting.enabled']),
  announcements: Boolean(settings['console_setting.announcements_enabled']),
  faq: Boolean(settings['console_setting.faq_enabled']),
  apiInfo: Boolean(settings['console_setting.api_info_enabled']),
  uptimeKuma: Boolean(settings['console_setting.uptime_kuma_enabled']),
  affEnabled:
    Number(settings.QuotaForInviter) > 0 || Number(settings.QuotaForInvitee) > 0,
  affInviter: Number(settings.QuotaForInviter) || 0,
  affInvitee: Number(settings.QuotaForInvitee) || 0,
})

export function FeatureTogglesSection({
  options,
}: {
  options: SystemOption[] | undefined
}) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const settings = useMemo(
    () => getOptionValue(options, FEATURE_DEFAULTS),
    [options]
  )
  const initialRef = useMemo(() => toFormValues(settings), [settings])

  const form = useForm<FeatureFormValues>({
    resolver: zodResolver(featureSchema),
    defaultValues: initialRef,
  })

  useEffect(() => {
    form.reset(initialRef)
  }, [initialRef, form])

  const toggleMeta: FeatureToggleMeta[] = [
    {
      key: 'selfUseMode',
      title: t('Self-use mode'),
      description: t(
        'Bill unpriced models at the default ratio instead of rejecting them.'
      ),
    },
    {
      key: 'register',
      title: t('Self-registration'),
      description: t(
        'Allow visitors to sign up. Keep off when accounts are created by the admin.'
      ),
    },
    {
      key: 'drawing',
      title: t('Drawing API (Midjourney)'),
      description: t(
        'Midjourney-style image relay and the drawing logs page.'
      ),
    },
    {
      key: 'task',
      title: t('Task API'),
      description: t(
        'Async task APIs (Suno, video, etc.) and the task logs page.'
      ),
    },
    {
      key: 'checkin',
      title: t('Daily check-in'),
      description: t('Users claim quota rewards by checking in daily.'),
    },
    {
      key: 'announcements',
      title: t('Announcements'),
      description: t('Announcement panel inside the console.'),
    },
    {
      key: 'faq',
      title: t('FAQ'),
      description: t('FAQ panel inside the console.'),
    },
    {
      key: 'apiInfo',
      title: t('API info'),
      description: t('API usage info panel inside the console.'),
    },
    {
      key: 'uptimeKuma',
      title: t('Uptime status'),
      description: t('Uptime Kuma status panel inside the console.'),
    },
  ]

  const onSubmit = async (values: FeatureFormValues) => {
    const initial = initialRef
    const updates: Array<{ key: string; value: string | boolean | number }> = []
    const pushIfChanged = (
      key: string,
      value: string | boolean | number,
      initialValue: string | boolean | number
    ) => {
      if (value !== initialValue) {
        updates.push({ key, value })
      }
    }

    pushIfChanged('SelfUseModeEnabled', values.selfUseMode, initial.selfUseMode)
    pushIfChanged('RegisterEnabled', values.register, initial.register)
    pushIfChanged(
      'PasswordRegisterEnabled',
      values.register,
      initial.register
    )
    pushIfChanged('DrawingEnabled', values.drawing, initial.drawing)
    pushIfChanged('TaskEnabled', values.task, initial.task)
    pushIfChanged('checkin_setting.enabled', values.checkin, initial.checkin)
    pushIfChanged(
      'console_setting.announcements_enabled',
      values.announcements,
      initial.announcements
    )
    pushIfChanged('console_setting.faq_enabled', values.faq, initial.faq)
    pushIfChanged(
      'console_setting.api_info_enabled',
      values.apiInfo,
      initial.apiInfo
    )
    pushIfChanged(
      'console_setting.uptime_kuma_enabled',
      values.uptimeKuma,
      initial.uptimeKuma
    )

    if (!values.affEnabled) {
      pushIfChanged('QuotaForInviter', 0, initial.affInviter)
      pushIfChanged('QuotaForInvitee', 0, initial.affInvitee)
    } else {
      pushIfChanged(
        'QuotaForInviter',
        values.affInviter,
        initial.affInviter
      )
      pushIfChanged(
        'QuotaForInvitee',
        values.affInvitee,
        initial.affInvitee
      )
    }

    for (const update of updates) {
      await updateOption.mutateAsync(update)
    }
  }

  const resetToDefault = () => {
    form.reset(initialRef)
  }

  return (
    <Form {...form}>
      <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
        <SettingsPageFormActions
          onSave={form.handleSubmit(onSubmit)}
          onReset={resetToDefault}
          isSaving={updateOption.isPending}
          resetLabel='Reset'
          saveLabel='Save feature switches'
        />
        <div className='grid gap-4 md:grid-cols-2'>
          {toggleMeta.map((module) => (
            <FormField
              key={module.key}
              control={form.control}
              name={module.key}
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{module.title}</FormLabel>
                    <FormDescription>{module.description}</FormDescription>
                  </SettingsSwitchContent>
                  <FormControl>
                    <Switch
                      checked={Boolean(field.value)}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </SettingsSwitchItem>
              )}
            />
          ))}
        </div>

        <SettingsControlGroup>
          <FormField
            control={form.control}
            name='affEnabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Invitation rebate')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Quota rewards for inviting new users. Positive values require confirming the payment compliance terms first.'
                    )}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </SettingsSwitchItem>
            )}
          />

          <SettingsControlChildren className='grid gap-3 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='affInviter'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Quota for inviter')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      value={field.value}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value) || 0)
                      }
                      disabled={!form.watch('affEnabled')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='affInvitee'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Quota for invitee')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      value={field.value}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value) || 0)
                      }
                      disabled={!form.watch('affEnabled')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsControlChildren>
        </SettingsControlGroup>
      </SettingsForm>
    </Form>
  )
}
