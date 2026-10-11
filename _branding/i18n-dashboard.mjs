import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

// key -> zh translation (en value defaults to the key itself)
const NEW_KEYS = {
  'Token Usage Analytics': 'Token 用量统计',
  'Token Usage Trend': 'Token 用量趋势',
  'Token Usage by Model': '按模型统计 Token',
  'Token Usage by API Key': '按 API 令牌统计',
  'Token Trend': 'Token 趋势',
  'Token Distribution': 'Token 占比',
  'Token Ranking': 'Token 排行',
  'Input Tokens': '输入 Token',
  'Output Tokens': '输出 Token',
  'Sum of input tokens': '输入 token 总和',
  'Sum of output tokens': '输出 token 总和',
  Unsplit: '未拆分（旧数据）',
  'No token usage data': '暂无令牌用量数据',
  'Failed to load token usage data': '令牌用量数据加载失败',
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
