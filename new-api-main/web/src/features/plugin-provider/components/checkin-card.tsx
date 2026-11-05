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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, Loader2, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getCheckinOptions, runCheckinNow, setCheckinOptions } from '../api'

/**
 * The daily check-in's own settings: whether it runs by itself, at what
 * hour, and how it last went.
 *
 * Pressing a vendor's daily button is the least interesting thing an
 * operator does and the easiest to forget, so it runs by itself unless
 * turned off. What it did last is shown beside the switch: a switch with no
 * outcome beside it cannot be trusted.
 */
export function CheckinCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const optionsQuery = useQuery({
    queryKey: ['plugin-provider', 'checkin-options'],
    queryFn: async () => requireServerSuccess(await getCheckinOptions()).data,
    retry: false,
  })

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })

  const setMutation = useMutation({
    mutationFn: async (input: { auto?: boolean; at?: number }) =>
      requireServerSuccess(await setCheckinOptions(input)),
    onSuccess: () => refresh(),
    onError: (error) => handleServerError(error),
  })

  const runMutation = useMutation({
    mutationFn: async () => requireServerSuccess(await runCheckinNow()),
    onSuccess: (res) => {
      const r = res.data
      if (r && r.claimed > 0) {
        toast.success(t('Checked in {{n}} account(s)', { n: r.claimed }))
      } else {
        toast.info(t('Nothing to claim right now'))
      }
      refresh()
    },
    onError: (error) => handleServerError(error),
  })

  const settings = optionsQuery.data?.settings
  if (!settings) {
    return null
  }

  const last = settings.last_run
    ? new Date(settings.last_run * 1000).toLocaleString()
    : ''

  return (
    <div className='bg-card rounded-lg border px-3 py-2.5 shadow-xs'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='bg-muted text-muted-foreground inline-flex size-7 items-center justify-center rounded-md'>
          <CalendarCheck className='size-4' aria-hidden='true' />
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='text-sm font-semibold'>{t('Daily check-in')}</span>
            {settings.auto ? (
              <Badge variant='secondary'>{t('On')}</Badge>
            ) : (
              <Badge variant='outline'>{t('Off')}</Badge>
            )}
          </div>
          <p className='text-muted-foreground mt-0.5 text-[11px]'>
            {settings.auto
              ? t(
                  'Runs by itself every day after {{hour}}:00, once per account until the vendor’s day turns.',
                  { hour: String(settings.at).padStart(2, '0') }
                )
              : t(
                  'Off: an account nobody presses keeps the credits unclaimed.'
                )}
            {last ? ` · ${t('last run {{when}}', { when: last })}` : ''}
          </p>
          {settings.last_said ? (
            <p className='text-muted-foreground mt-0.5 text-[11px]'>
              {settings.last_said}
            </p>
          ) : null}
        </div>

        <div className='flex shrink-0 items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={runMutation.isPending}
            onClick={() => runMutation.mutate()}
            title={t('Press every vendor’s check-in now.')}
          >
            {runMutation.isPending ? (
              <Loader2
                data-icon='inline-start'
                className='animate-spin'
                aria-hidden='true'
              />
            ) : (
              <Play data-icon='inline-start' aria-hidden='true' />
            )}
            {t('Run now')}
          </Button>
          <Switch
            checked={settings.auto}
            disabled={setMutation.isPending}
            onCheckedChange={(on) => setMutation.mutate({ auto: on })}
            aria-label={t('Daily check-in')}
          />
        </div>
      </div>
    </div>
  )
}
