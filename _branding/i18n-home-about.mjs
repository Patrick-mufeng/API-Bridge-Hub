import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

const NEW_KEYS = {
  'Personal AI relay for you and your friends.':
    '为你和你的朋友搭建的个人 AI 中转站',
  'One OpenAI-compatible endpoint for all upstream channels. Create a key, set the Base URL, and go.':
    '多个上游渠道聚合为一个 OpenAI 兼容接口；创建密钥、填好 Base URL，即可使用',
  'Relay Channels': '聚合渠道',
  'You have {{count}} models available': '你可用 {{count}} 个模型',
  'Sign in to see your available models.': '登录后可查看可用模型',
  'About BridgeHub': '关于 BridgeHub',
  'BridgeHub is a personal AI API relay: multiple upstream model channels are aggregated behind one OpenAI-compatible endpoint, with per-channel model prefixes so you always know which upstream serves a request.':
    'BridgeHub 是一个个人 AI API 中转站：多个上游模型服务聚合在一个 OpenAI 兼容接口后面，模型按渠道带前缀，每个请求走哪个上游一目了然。',
  'Unified endpoint': '统一接口',
  'OpenAI-compatible /v1 — works with common clients out of the box.':
    'OpenAI 兼容的 /v1 接口，常见客户端开箱即用',
  'Per-channel prefixes': '渠道前缀',
  'wb:, qd:, cl:, ocz:, tr:, cg: — pick the exact upstream you want.':
    '模型带渠道前缀（wb:、qd: 等），可明确指定使用哪个上游',
  'Token analytics': 'Token 统计',
  'The dashboard tracks token usage per model and per key.':
    '数据看板按模型、按密钥统计 Token 用量',
  'Admin-issued accounts': '管理员发号',
  'Accounts and quota are managed by the administrator.':
    '账号与额度由管理员发放，无自助注册',
  'Getting started': '快速开始',
  'Ask the administrator for an account, create a key under API Keys, then point your client at {{address}}/v1. The API Keys page has a full connection guide.':
    '向管理员获取账号，在「API 密钥」页创建密钥，客户端接口地址填 {{address}}/v1。「API 密钥」页有完整连接教程。',
}

const read = (f) => JSON.parse(readFileSync(`${LOCALES}/${f}`, 'utf8'))
const write = (f, data) =>
  writeFileSync(`${LOCALES}/${f}`, JSON.stringify(data, null, 2) + '\n')

const en = read('en.json')
const zh = read('zh.json')

let added = 0
for (const [key, value] of Object.entries(NEW_KEYS)) {
  if (!(key in en.translation)) {
    en.translation[key] = key
    added++
  }
  if (!(key in zh.translation)) zh.translation[key] = value
}

write('en.json', en)
write('zh.json', zh)
console.log('added', added, 'keys; en total', Object.keys(en.translation).length)
