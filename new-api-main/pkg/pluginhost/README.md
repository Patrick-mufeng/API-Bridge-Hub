# pluginhost

The plugin host: community plugins (OpenCode's plugin format) sign a vendor's
subscription in, list its models and make each request on the vendor's own
wire. new-api keeps the channel, the routing and the billing around them.

Ported from [magpie](https://github.com/yetone/magpie) (MIT, see
`LICENSE.magpie`). What changed and why is below; everything else is
magpie's, kept as it was so a community plugin runs here exactly as it does
there.

## Layout

| File | What it is |
| --- | --- |
| `host.js` | The OpenCode plugin contract, **unmodified**. Runs on Bun, one process for every plugin, RPC over stdin/stdout. |
| `pi.js` | pi's packages loaded as plugins, also unmodified. |
| `host.go` | The host's Go side: child lifecycle, the RPC, stream backpressure, cancellation. |
| `providers.go` | A plugin's providers, accounts, sign-in, allowance. |
| `store.go` | `plugins.json` (what is installed) and `plugin-auth.json` (the sign-ins). |
| `bun.go`, `bunupdate.go` | Bun, downloaded on first use (with SHA-256 from Bun's own manifest). |
| `market.go`, `updates.go` | The community plugin list and version updates. |
| `support/` | The parts of magpie's own internal packages the host calls, reimplemented. |

## What differs from magpie

The host calls into 13 of magpie's internal packages. Most of what they do
has no caller here — magpie is a desktop app that probes login shells,
reads macOS network settings and edits agents' config files; this is a
server component inside a relay. So those packages are reimplemented to the
symbols the host actually uses:

| magpie package | Upstream size | Here | Why |
| --- | --- | --- | --- |
| `internal/proc` | 4,418 lines | ~200 | login-shell and PATH discovery has no caller |
| `internal/edit` | 3,618 lines | ~25 | JSONC/TOML/YAML format-preserving editors unused; only `WriteAtomic` is |
| `internal/update` | 4,397 lines | ~120 | only `Newer` and `Reexec` |
| `internal/netproxy` | 1,560 lines | ~300 + the SOCKS5 bridge verbatim | a server takes its proxy from the environment |
| `internal/settings` | 3,162 lines | ~120 | the host's settings are its own, not new-api's option table |

`internal/steady`, `internal/filememo`, `internal/lastgood` and
`internal/libc` are magpie's, close to verbatim: they are what keeps a
state file from being read as empty when Windows is renaming it, and they
are the reason a crashed write can't erase an account list.

## Where its files go

`<binary>/data/plugin-host/`, beside the reverse-proxy manager's manifests:

```
data/plugin-host/
├── settings.json           this host's own settings
├── plugins.json            what is installed
├── plugin-auth.json        the sign-ins (never in the database, never logged)
├── plugin-providers.json   the last model list each plugin gave
├── plugins/                the npm packages, with bun.lock
└── cache/                  Bun itself, models.dev, the plugin market
```

`PLUGIN_HOST_CONFIG_DIR` and `PLUGIN_HOST_CACHE_DIR` move them;
`MAGPIE_BUN` points at a Bun to use instead of downloading one.

## The check it was built against

```sh
go run ./cmd/plugprobe install @magpie-community/opencode-workbuddy-auth
go run ./cmd/plugprobe providers workbuddy
go run ./cmd/plugprobe chat workbuddy glm-5.3 "hello"
go run ./cmd/plugprobe tools workbuddy glm-5.3
```

`plugprobe` is a development tool, not part of the relay. It exists so the
host's contract can be checked without the hub, and so a plugin that stops
working can be told apart from the relay around it.
