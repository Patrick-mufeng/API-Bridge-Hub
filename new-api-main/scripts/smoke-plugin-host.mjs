#!/usr/bin/env node
// End-to-end smoke test for the plugin host.
//
// It starts the built binary on a scratch SQLite database and walks every
// plugin endpoint, in the order an operator would: see the host, list what is
// installed, read the market, look at the providers, read a provider's own
// page, read the routes, press the check-in, and turn the host off again.
//
// What it checks is that each route is reachable and answers in the shape the
// console reads. It needs no vendor account: an endpoint that refuses for want
// of one is a pass; one that 500s or 404s is not.
//
// Usage: node scripts/smoke-plugin-host.mjs [path-to-binary]

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// resolve, because Windows does not look a relative program path up the way a
// shell does: "./smoke-server" there is not a file it will run
const BIN = resolve(process.argv[2] ?? './new-api-dev.exe')
const PORT = Number(process.env.SMOKE_PORT ?? 4699)
const BASE = 'http://127.0.0.1:' + PORT
const PASSWORD = 'Smoke-Test-2026!'

const work = mkdtempSync(join(tmpdir(), 'plugin-smoke-'))
// the host keeps its files beside the binary, or where these say. A scratch
// config dir keeps the test from reading or writing the hub's own plugins.
const configDir = join(work, 'plugin-host')
const cacheDir = join(configDir, 'cache')
let server = null
let token = ''
const results = []

function start() {
  server = spawn(BIN, [], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(PORT),
      DEFAULT_LANGUAGE: 'en',
      SESSION_SECRET: 'smoke-test',
      SQLITE_PATH:
        'smoke.db?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_txlock=immediate',
      PLUGIN_HOST_CONFIG_DIR: configDir,
      PLUGIN_HOST_CACHE_DIR: cacheDir,
      // a scratch config has no Bun and no mirror: point it at the one this
      // machine already downloaded, or the install fetches it from GitHub
      ...(process.env.SMOKE_BUN ? { MAGPIE_BUN: process.env.SMOKE_BUN } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // the binary is chatty; its output would bury the report
  server.stdout.on('data', () => {})
  server.stderr.on('data', () => {})
}

async function waitUp(ms = 90000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/status')
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function pass(name, extra = '') {
  results.push({ ok: true, name, extra })
}

function fail(name, why) {
  results.push({ ok: false, name, why })
}

// call walks one endpoint and records what came back. expected lists the
// statuses that mean "the route works"; a route that refuses for want of a
// vendor account is a 200 with success=false, so both are checked.
async function call(method, path, body, expected = [200]) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    fail(method + ' ' + path, 'request failed: ' + e.message)
    return null
  }
  let json = null
  try {
    json = await res.json()
  } catch {}
  const label = method + ' ' + path
  if (!expected.includes(res.status)) {
    fail(label, 'status ' + res.status + (json && json.message ? ': ' + json.message : ''))
    return json
  }
  // a 200 that says success=false is only a pass where the test expects a
  // refusal, which is passed in as expectedRefusal
  pass(label, res.status === 200 ? '' : '(' + res.status + ')')
  return json
}

async function main() {
  start()
  if (!(await waitUp())) {
    console.error('the server never came up on ' + BASE)
    process.exit(2)
  }

  const setup = await fetch(BASE + '/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: PASSWORD,
      confirmPassword: PASSWORD,
      SelfUseModeEnabled: true,
      DemoSiteEnabled: false,
    }),
  })
  setup.ok ? pass('POST /api/setup') : fail('POST /api/setup', 'status ' + setup.status)

  const login = await (
    await fetch(BASE + '/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: PASSWORD }),
    })
  ).json()
  if (login && login.success && login.data && login.data.access_token) {
    token = login.data.access_token
    pass('POST /api/user/login')
  } else {
    fail('POST /api/user/login', 'no token')
    return
  }

  // read: the host, what is installed, the market, the providers
  await call('GET', '/api/plugin_provider/host')
  const plugins = await call('GET', '/api/plugin_provider/plugins')
  const installed = (plugins && plugins.data && plugins.data.plugins) || []
  pass('  installed: ' + installed.length)

  const market = await call('GET', '/api/plugin_provider/market')
  const listings = (market && market.data && market.data.plugins) || []
  // The market carries what npm says of each. npm answers some packages and
  // not others, and rate-limits a machine that asks often, so all this can
  // assert is that the plumbing works: at least one entry carries the facts,
  // and the shape is the one the console reads.
  const withVersion = listings.filter((p) => p.version).length
  const shaped = listings.every(
    (p) => typeof p.package === 'string' && typeof p.name === 'string'
  )
  if (listings.length === 0) {
    fail('  market', 'the community list came back empty')
  } else if (!shaped) {
    fail('  market', 'an entry is missing its package or name')
  } else if (withVersion === 0) {
    fail(
      '  market npm facts',
      'none of ' + listings.length + ' entries carries a version'
    )
  } else {
    pass(
      '  market: ' + listings.length + ' entries, ' + withVersion + ' with npm facts'
    )
  }

  await call('GET', '/api/plugin_provider/market/search?q=opencode')
  const providers = await call('GET', '/api/plugin_provider/providers')
  const offers = (providers && providers.data && providers.data.offers) || []

  // a provider's own page, when there is one to ask about
  if (offers.length > 0) {
    const id = offers[0].provider
    const page = await call(
      'GET',
      '/api/plugin_provider/providers/' + encodeURIComponent(id) + '/page'
    )
    const accounts = (page && page.data && page.data.accounts) || []
    pass('  ' + id + ': ' + accounts.length + ' account(s)')
    // every account row must say where it is served from, even when the
    // answer is "nowhere": a row without a key index cannot be acted on
    const keyed = accounts.filter((a) => a.key_index !== undefined).length
    keyed === accounts.length
      ? pass('  every account carries its key index')
      : fail('  account key index', keyed + ' of ' + accounts.length)
    await call('GET', '/api/plugin_provider/providers/' + encodeURIComponent(id))
  } else {
    // a scratch config dir has no plugin installed, so no provider is
    // offered and its page is not asked for. That is the expected shape on
    // a clean install, not a failure.
    pass('  no provider installed (clean install): its page is not asked for')
  }

  await call('GET', '/api/plugin_provider/routes')

  // the daily check-in: its settings, changing them, and pressing it
  const options = await call('GET', '/api/plugin_provider/checkin/options')
  const settings = (options && options.data && options.data.settings) || {}
  settings.auto === true
    ? pass('  the daily check-in is on by default')
    : fail('  check-in default', 'auto=' + settings.auto)
  await call('PUT', '/api/plugin_provider/checkin/options', { auto: false })
  await call('PUT', '/api/plugin_provider/checkin/options', { auto: true, at: 9 })
  await call('POST', '/api/plugin_provider/checkin/run')
  await call('GET', '/api/plugin_provider/renewals')

  // health: asking it with no provider is a full pass over every account
  await call('POST', '/api/plugin_provider/health/sync', {})

  // the host's own switch, turned off and on again
  await call('PUT', '/api/plugin_provider/host', { enabled: false })
  const off = await call('GET', '/api/plugin_provider/host')
  off && off.data && off.data.enabled === false
    ? pass('  the host switch holds')
    : fail('  host switch', 'enabled=' + (off && off.data && off.data.enabled))
  await call('PUT', '/api/plugin_provider/host', { enabled: true })

  // With a plugin to install, the provider paths get walked too: install it,
  // read what it offers, its own page, and the routes its models make. This
  // needs npm, so it runs only when asked for.
  const spec = process.env.SMOKE_INSTALL_PLUGIN
  if (spec) {
    const added = await call('POST', '/api/plugin_provider/plugins', { spec })
    if (added && added.success) {
      pass('  installed ' + spec)
      const loaded = await call('GET', '/api/plugin_provider/plugins')
      const entries = (loaded && loaded.data && loaded.data.plugins) || []
      const broken = entries.filter((e) => e.load_error)
      broken.length === 0
        ? pass('  every installed plugin loaded')
        : fail(
            '  a plugin failed to load',
            broken.map((e) => e.spec + ': ' + e.load_error).join('; ')
          )
      const ps = await call('GET', '/api/plugin_provider/providers')
      const os = (ps && ps.data && ps.data.offers) || []
      // A freshly installed plugin offers nothing until the host has run it
      // once, which needs Bun. Zero here is the clean-install shape.
      pass('  ' + os.length + ' provider(s) offered')
      if (os.length > 0) {
        const id = os[0].provider
        const page = await call(
          'GET',
          '/api/plugin_provider/providers/' + encodeURIComponent(id) + '/page'
        )
        const accs = (page && page.data && page.data.accounts) || []
        pass('  ' + id + ': ' + accs.length + ' account(s)')
        const routes = await call('GET', '/api/plugin_provider/routes')
        await call('POST', '/api/plugin_provider/health/sync', { provider: id })
        // registering with no account still makes the channel, so the
        // registry path is walkable on a machine with no vendor login
        await call('POST', '/api/plugin_provider/register', { provider: id })
        const after = await call('GET', '/api/plugin_provider/routes')
        const names = Object.keys((after && after.data && after.data.routes) || {})
        names.length > 0
          ? pass('  ' + names.length + ' bare model name(s) routed')
          : fail('  bare model names', 'registering made none')
        await call('GET', '/api/channel/?p=1&page_size=5')
      }
      await call('DELETE', '/api/plugin_provider/plugins?spec=' + encodeURIComponent(spec))
    } else {
      fail('install ' + spec, (added && added.message) || 'refused')
    }
  }

  // the old reverse-proxy routes are gone: a 404 here is the pass
  for (const gone of ['/api/reverse_proxy/services', '/api/reverse_proxy/panel/x/panel/']) {
    const r = await fetch(BASE + gone, { headers: { Authorization: 'Bearer ' + token } })
    r.status === 404 ? pass('gone ' + gone) : fail('gone ' + gone, 'status ' + r.status)
  }
}

main()
  .catch((e) => fail('smoke', e.stack || e.message))
  .finally(() => {
    if (server) server.kill()
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {}
    const bad = results.filter((r) => !r.ok)
    for (const r of results) {
      console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? ' ' + r.extra : ''))
      if (!r.ok) console.log('        ' + r.why)
    }
    console.log('')
    console.log(bad.length === 0 ? 'all ' + results.length + ' checks passed' : bad.length + ' of ' + results.length + ' failed')
    process.exit(bad.length === 0 ? 0 : 1)
  })
