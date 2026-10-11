import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

const NEW_KEYS = {
  'One API,': '一个 API，',
  'every model service.': '直达所有模型服务',
  'BridgeHub aggregates multiple upstream channels behind one OpenAI-compatible endpoint. New services plug in as manifests, register as channels, and every model is reachable with a single key.':
    'BridgeHub 把多个上游渠道聚合在一个 OpenAI 兼容接口后面：新服务以插件形式接入即注册为渠道，一个密钥可达所有模型。',
  'One API, every service': '一个 API，所有服务',
  'One OpenAI-compatible /v1 with a single key across all channels.':
    'OpenAI 兼容的 /v1，一个密钥访问全部渠道',
  'Plug-in onboarding': '插件式接入',
  'Drop in a manifest and the service registers itself as a channel — hot-pluggable, no code changes.':
    '丢一份清单文件即可注册为新渠道，热插拔、不改代码',
  'Full connection guide lives on the API Keys page.':
    '完整连接教程在「API 密钥」页',
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
