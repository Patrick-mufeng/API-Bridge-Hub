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
import { BarChart3, Network, Puzzle, Tags } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function FeaturesRow() {
  const { t } = useTranslation()

  const features = [
    {
      icon: Network,
      title: t('One API, every service'),
      description: t(
        'One OpenAI-compatible /v1 with a single key across all channels.'
      ),
    },
    {
      icon: Puzzle,
      title: t('Plug-in onboarding'),
      description: t(
        'Drop in a manifest and the service registers itself as a channel — hot-pluggable, no code changes.'
      ),
    },
    {
      icon: Tags,
      title: t('Channel prefixes'),
      description: t(
        'wb:, qd:, cl:, ocz:, tr:, cg: — pick the exact upstream you want.'
      ),
    },
    {
      icon: BarChart3,
      title: t('Token analytics'),
      description: t(
        'The dashboard tracks token usage per model and per key.'
      ),
    },
  ]

  return (
    <section className='relative z-10 px-6 pt-16 pb-14'>
      <div className='mx-auto grid max-w-5xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4'>
        {features.map((feature) => (
          <div key={feature.title}>
            <div className='bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg'>
              <feature.icon className='size-4.5' />
            </div>
            <h3 className='mt-3.5 text-sm font-semibold'>{feature.title}</h3>
            <p className='text-muted-foreground mt-1.5 text-xs leading-relaxed'>
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
