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

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import { pluginSignInKey, pollPluginSignIn, startPluginSignIn } from '../api'
import type { PluginMethod, SignInPrompt } from '../types'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: string
  providerName: string
  methods: PluginMethod[]
}

type Phase = 'pick' | 'ask' | 'waiting' | 'key'

/**
 * Signing an account in. A method either asks questions first (a domain, a
 * team, a key), opens a page and waits for it, or finishes at once.
 *
 * The waiting phase polls, because an OAuth sign-in ends when the person
 * finishes on the vendor's page, not when this dialog does anything.
 */
export function SignInDialog({
  open,
  onOpenChange,
  provider,
  providerName,
  methods,
}: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<Phase>('pick')
  const [methodIndex, setMethodIndex] = useState(0)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [prompt, setPrompt] = useState<SignInPrompt | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [authURL, setAuthURL] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = () => {
    setPhase('pick')
    setMethodIndex(0)
    setInputs({})
    setPrompt(null)
    setPromptValue('')
    setAuthURL('')
    setKeyValue('')
    setError('')
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    if (!open) {
      reset()
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [open])

  const done = () => {
    toast.success(t('Account signed in'))
    void queryClient.invalidateQueries({ queryKey: ['plugin-provider'] })
    onOpenChange(false)
  }

  const startMutation = useMutation({
    mutationFn: async (input: {
      method: number
      inputs: Record<string, string>
    }) => requireServerSuccess(await startPluginSignIn({ provider, ...input })),
    onSuccess: (res) => {
      const data = res.data
      if (!data) {
        setError(t('The plugin said nothing'))
        return
      }
      if (data.prompt) {
        setPrompt(data.prompt)
        setPromptValue('')
        setPhase('ask')
        return
      }
      if (data.saved) {
        done()
        return
      }
      if (data.session) {
        setAuthURL(data.url ?? '')
        setPhase('waiting')
        startPolling(data.session)
        return
      }
      // a method that finished with nothing to wait for
      done()
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err))
      handleServerError(err)
    },
  })

  const startPolling = (s: string) => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    // a poll that fails is retried by the next tick, so its error is the
    // tick's own and not the dialog's
    const tick = async () => {
      let finished = false
      try {
        const res = await pollPluginSignIn(provider, s)
        finished = requireServerSuccess(res).data?.done === true
      } catch {
        finished = false
      }
      if (!finished) {
        return
      }
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      done()
    }
    pollRef.current = setInterval(() => void tick(), 2000)
  }

  const keyMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(
        await pluginSignInKey({
          provider,
          method: methodIndex,
          inputs,
          key: keyValue,
        })
      ),
    onSuccess: () => done(),
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err))
      handleServerError(err)
    },
  })

  const submitPrompt = () => {
    const next = { ...inputs, [prompt?.key ?? '']: promptValue }
    setInputs(next)
    setPrompt(null)
    startMutation.mutate({ method: methodIndex, inputs: next })
  }

  const pickMethod = (index: number) => {
    const method = methods[index]
    setMethodIndex(index)
    setError('')
    setInputs({})
    if (method.type === 'api') {
      setPhase('key')
      return
    }
    startMutation.mutate({ method: index, inputs: {} })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {t('Sign in to {{name}}', { name: providerName })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'The plugin keeps the sign-in; no password or token is stored in the database.'
            )}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2.5 text-xs break-words'>
            {error}
          </div>
        ) : null}

        {phase === 'pick' ? (
          <div className='space-y-2'>
            {methods.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('This plugin offers no sign-in method.')}
              </p>
            ) : null}
            {methods.map((method) => (
              <button
                key={method.index}
                type='button'
                onClick={() => pickMethod(method.index)}
                className='hover:bg-muted/60 flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors'
              >
                <span className='bg-muted text-muted-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md'>
                  {method.type === 'api' ? (
                    <KeyRound className='size-3.5' aria-hidden='true' />
                  ) : (
                    <ExternalLink className='size-3.5' aria-hidden='true' />
                  )}
                </span>
                <span className='min-w-0'>
                  <span className='block text-sm font-medium'>
                    {method.label}
                  </span>
                  <span className='text-muted-foreground block text-xs'>
                    {method.type === 'api'
                      ? t('Paste a key made on the vendor’s own site')
                      : t('A page opens; nothing to paste')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {phase === 'ask' && prompt ? (
          <div className='space-y-2'>
            <p className='text-sm'>{prompt.message}</p>
            {prompt.options && prompt.options.length > 0 ? (
              <div className='space-y-1.5'>
                {prompt.options.map((o) => (
                  <button
                    key={o.value}
                    type='button'
                    onClick={() => {
                      const next = { ...inputs, [prompt.key]: o.value }
                      setInputs(next)
                      setPrompt(null)
                      startMutation.mutate({
                        method: methodIndex,
                        inputs: next,
                      })
                    }}
                    className='hover:bg-muted/60 w-full rounded-md border p-2 text-left text-sm'
                  >
                    {o.label}
                    {o.hint ? (
                      <span className='text-muted-foreground block text-xs'>
                        {o.hint}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <Input
                  type={prompt.type === 'password' ? 'password' : 'text'}
                  value={promptValue}
                  placeholder={prompt.placeholder}
                  onChange={(event) => setPromptValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submitPrompt()
                    }
                  }}
                />
                <Button
                  size='sm'
                  onClick={submitPrompt}
                  disabled={startMutation.isPending}
                >
                  {t('Continue')}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {phase === 'key' ? (
          <div className='space-y-2'>
            <p className='text-sm'>
              {methods[methodIndex]?.key_title ?? t('Paste the API key')}
            </p>
            <Input
              type='password'
              value={keyValue}
              placeholder={methods[methodIndex]?.placeholder}
              onChange={(event) => setKeyValue(event.target.value)}
            />
            <Button
              size='sm'
              onClick={() => keyMutation.mutate()}
              disabled={keyMutation.isPending || keyValue.trim() === ''}
            >
              {keyMutation.isPending ? (
                <Loader2
                  data-icon='inline-start'
                  className='animate-spin'
                  aria-hidden='true'
                />
              ) : null}
              {t('Sign in')}
            </Button>
          </div>
        ) : null}

        {phase === 'waiting' ? (
          <div className='space-y-3'>
            <div className='flex items-center gap-2 text-sm'>
              <Loader2 className='size-4 animate-spin' aria-hidden='true' />
              {t('Waiting for the sign-in to finish…')}
            </div>
            {authURL ? (
              <div className='space-y-2'>
                <p className='text-muted-foreground text-xs'>
                  {t('If the page did not open, use this link:')}
                </p>
                <a
                  href={authURL}
                  target='_blank'
                  rel='noreferrer'
                  className='text-primary inline-flex items-center gap-1 text-xs break-all underline'
                >
                  {authURL}
                  <ExternalLink
                    className='size-3 shrink-0'
                    aria-hidden='true'
                  />
                </a>
              </div>
            ) : null}
            <Badge variant='outline'>{t('This closes on its own')}</Badge>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant='outline'
            size='sm'
            onClick={() => onOpenChange(false)}
          >
            {phase === 'waiting' ? t('Close') : t('Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
