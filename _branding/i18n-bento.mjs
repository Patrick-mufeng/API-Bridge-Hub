import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

const NEW_KEYS = {
  'Pick a model': '选择模型',
  'Available models': '可用模型',
  'Open API Keys': '前往 API 密钥页',
  'Sign in to get started': '登录后即可开始使用',
  Copied: '已复制',
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
