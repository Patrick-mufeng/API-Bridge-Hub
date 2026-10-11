import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

const NEW_KEYS = {
  'Connection Guide': '连接教程',
  'Three steps to connect your apps.': '三步把你的应用接入本站',
  'Step 1. Create an API key': '第 1 步：创建 API 密钥',
  'Click "Create API Key" on this page and copy the sk-... secret. Keep it private.':
    '在本页点击「创建 API 密钥」，复制 sk- 开头的密钥并妥善保管。',
  'Step 2. Configure the endpoint': '第 2 步：配置接口地址',
  'OpenAI-compatible endpoint (remember the /v1 suffix):':
    'OpenAI 兼容接口地址（注意结尾的 /v1 不能少）：',
  'Step 3. Pick a model': '第 3 步：选择模型',
  'Each upstream channel prefixes its models (wb:, qd:, cl:, ocz:, tr:, cg: ...). Open Model Square for the full catalog.':
    '各上游渠道的模型带前缀（wb:、qd:、cl:、ocz:、tr:、cg: 等），完整列表在「模型广场」查看。',
  'Example request': '调用示例',
  'Copy example': '复制示例',
  'sk-your-api-key': 'sk-你的密钥',
  'Common clients (Cherry Studio, NextChat, Cline, etc.): pick the OpenAI-compatible provider, set the Base URL to the endpoint above, and paste your key.':
    '常用客户端（Cherry Studio、NextChat、Cline 等）：选择 OpenAI 兼容渠道，Base URL 填上面的地址，API Key 填你的密钥。',
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

// 'Hello' is used inside the curl example; make sure it exists
if (!('Hello' in zh.translation)) {
  en.translation['Hello'] = 'Hello'
  zh.translation['Hello'] = '你好'
  added++
}

write('en.json', en)
write('zh.json', zh)
console.log('added', added, 'keys; en total', Object.keys(en.translation).length)
