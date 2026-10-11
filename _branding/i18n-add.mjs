import { readFileSync, writeFileSync } from 'node:fs'

const LOCALES = 'C:/work_file/API-Bridge-Hub/new-api-main/web/src/i18n/locales'

// key -> zh translation (en value defaults to the key itself)
const NEW_KEYS = {
  'Feature Config': '功能配置',
  'Toggle product modules on demand. Hidden entries disappear from the navigation for every user, and public pages are additionally blocked server-side.':
    '按需开关产品模块：关闭后入口对所有用户隐藏，公开页面还会被后端拦截。',
  'Feature switches': '功能开关',
  'Master switches for registration, check-in, drawing, tasks and console panels.':
    '注册、签到、绘图、任务与控制台面板的总开关。',
  'Top navigation entries. Model Square and Rankings are also enforced by the backend.':
    '顶栏导航入口。模型广场与排行榜还会被后端强制拦截。',
  'Sidebar pages per area. Disabling a page hides it for every user.':
    '各分区的侧边栏页面。关闭后对所有人隐藏。',
  'Self-use mode': '自用模式',
  'Bill unpriced models at the default ratio instead of rejecting them.':
    '未定价的模型按默认倍率计费，而不是直接拒绝请求。',
  'Self-registration': '自助注册',
  'Allow visitors to sign up. Keep off when accounts are created by the admin.':
    '允许访客自行注册账号。由管理员手动建号时建议关闭。',
  'Drawing API (Midjourney)': '绘图 API（Midjourney）',
  'Midjourney-style image relay and the drawing logs page.':
    'Midjourney 风格的绘图中转与绘图日志页。',
  'Task API': '任务 API',
  'Async task APIs (Suno, video, etc.) and the task logs page.':
    '异步任务 API（Suno、视频等）与任务日志页。',
  'Daily check-in': '每日签到',
  'Users claim quota rewards by checking in daily.':
    '用户每天签到领取额度奖励。',
  'Announcement panel inside the console.': '控制台内的公告面板。',
  'FAQ panel inside the console.': '控制台内的常见问答面板。',
  'API info': 'API 信息',
  'API usage info panel inside the console.': '控制台内的 API 接入说明面板。',
  'Uptime status': '运行状态',
  'Uptime Kuma status panel inside the console.':
    '控制台内的 Uptime Kuma 状态面板。',
  'Invitation rebate': '邀请返利',
  'Quota rewards for inviting new users. Positive values require confirming the payment compliance terms first.':
    '邀请新用户的额度奖励。设置为正数前需先确认支付合规条款。',
  'Quota for inviter': '邀请人奖励额度',
  'Quota for invitee': '被邀请人奖励额度',
  'Save feature switches': '保存功能开关',
  'Marketplace and management for task plugins.': '任务插件市场与管理。',
  'Server runtime and environment information.': '服务器运行时与环境信息。',
  'Powered by': '基于开源框架',
  'Based on the open source project': '本项目基于开源项目',
  '(AGPL v3.0). Thanks to QuantumNous and One API.':
    '（AGPL v3.0）构建，感谢 QuantumNous 与 One API。',
}

// existing zh values that still mention the upstream brand in user-visible spots
const ZH_VALUE_UPDATES = {
  'Supports one-click configuration and perfectly adapts to NewAPI multi-protocol configuration.':
    '支持一键配置，适配多协议接入',
  'Welcome to our New API...': '欢迎使用 BridgeHub...',
  'e.g. New API Console': '例如，BridgeHub 控制台',
}

const read = (f) => JSON.parse(readFileSync(`${LOCALES}/${f}`, 'utf8'))
const write = (f, data) =>
  writeFileSync(`${LOCALES}/${f}`, JSON.stringify(data, null, 2) + '\n')

const en = read('en.json')
const zh = read('zh.json')

for (const [key, value] of Object.entries(NEW_KEYS)) {
  if (!(key in en.translation)) en.translation[key] = key
  if (!(key in zh.translation)) zh.translation[key] = value
}
for (const [key, value] of Object.entries(ZH_VALUE_UPDATES)) {
  if (key in zh.translation) zh.translation[key] = value
}

write('en.json', en)
write('zh.json', zh)
console.log(
  'en keys:',
  Object.keys(en.translation).length,
  'zh keys:',
  Object.keys(zh.translation).length
)
