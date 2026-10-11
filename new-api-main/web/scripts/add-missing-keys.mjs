import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n'
}

const newKeys = {
  en: {
    "Model prefix": "Model prefix",
    "None": "None",
    Build: 'Build',
    'Build finished': 'Build finished',
    'Channel registered': 'Channel registered',
    'Copy panel URL': 'Copy panel URL',
    'Drop a JSON manifest into the services directory and reload.':
      'Drop a JSON manifest into the services directory and reload.',
    'Loading logs...': 'Loading logs...',
    'Loading panel...': 'Loading panel...',
    'Loading reverse proxy services...': 'Loading reverse proxy services...',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      'Local reverse proxy services described by manifests, with their relay channels and panels.',
    Manifest: 'Manifest',
    'Manifest directory': 'Manifest directory',
    'Manifest errors': 'Manifest errors',
    'Manifests reloaded': 'Manifests reloaded',
    'No log output yet.': 'No log output yet.',
    'No reverse proxy services found.': 'No reverse proxy services found.',
    'Not built yet': 'Not built yet',
    PID: 'PID',
    Panel: 'Panel',
    'Panel failed to load.': 'Panel failed to load.',
    'Panel unavailable': 'Panel unavailable',
    'Register channel': 'Register channel',
    'Reload manifests': 'Reload manifests',
    Restart: 'Restart',
    'Reverse Proxy': 'Reverse Proxy',
    'Reverse proxy service panel': 'Reverse proxy service panel',
    'Service API key': 'Service API key',
    'Service log · auto-refreshing every {{seconds}}s':
      'Service log · auto-refreshing every {{seconds}}s',
    'Service panel': 'Service panel',
    'Service restarted': 'Service restarted',
    'Service started': 'Service started',
    'Service stopped': 'Service stopped',
    Services: 'Services',
    Stopped: 'Stopped',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      'The embedded panel receives this key automatically; copy it only for other clients.',
    Unhealthy: 'Unhealthy',
    'We could not load reverse proxy services.':
      'We could not load reverse proxy services.',
    'We could not load the service log.': 'We could not load the service log.',
    'We could not read the service API key.':
      'We could not read the service API key.',
    Workdir: 'Workdir',
  },
  zh: {
    "Model prefix": "模型前缀",
    "None": "无",
    Build: '构建',
    'Build finished': '构建完成',
    'Channel registered': '渠道已注册',
    'Copy panel URL': '复制面板地址',
    'Drop a JSON manifest into the services directory and reload.':
      '将 JSON 清单文件放入服务目录后重新加载。',
    'Loading logs...': '正在加载日志…',
    'Loading panel...': '正在加载面板…',
    'Loading reverse proxy services...': '正在加载反代服务…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      '由清单文件描述的本机反代服务，及其接入的渠道与内嵌面板。',
    Manifest: '清单文件',
    'Manifest directory': '清单目录',
    'Manifest errors': '清单加载错误',
    'Manifests reloaded': '清单已重新加载',
    'No log output yet.': '暂无日志输出。',
    'No reverse proxy services found.': '未发现反代服务。',
    'Not built yet': '尚未构建',
    PID: 'PID',
    Panel: '面板',
    'Panel failed to load.': '面板加载失败。',
    'Panel unavailable': '面板不可用',
    'Register channel': '注册渠道',
    'Reload manifests': '重新加载清单',
    Restart: '重启',
    'Reverse Proxy': '反代服务',
    'Reverse proxy service panel': '反代服务面板',
    'Service API key': '服务 API 密钥',
    'Service log · auto-refreshing every {{seconds}}s':
      '服务日志 · 每 {{seconds}} 秒自动刷新',
    'Service panel': '服务面板',
    'Service restarted': '服务已重启',
    'Service started': '服务已启动',
    'Service stopped': '服务已停止',
    Services: '服务',
    Stopped: '已停止',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      '嵌入的面板会自动获取该密钥，仅在供其他客户端使用时才需要复制。',
    Unhealthy: '运行异常',
    'We could not load reverse proxy services.': '无法加载反代服务。',
    'We could not load the service log.': '无法加载服务日志。',
    'We could not read the service API key.': '无法读取服务 API 密钥。',
    Workdir: '工作目录',
  },
  'zh-TW': {
    "Model prefix": "模型前綴",
    "None": "無",
    Build: '建置',
    'Build finished': '建置完成',
    'Channel registered': '渠道已註冊',
    'Copy panel URL': '複製面板網址',
    'Drop a JSON manifest into the services directory and reload.':
      '將 JSON 清單檔放入服務目錄後重新載入。',
    'Loading logs...': '正在載入日誌…',
    'Loading panel...': '正在載入面板…',
    'Loading reverse proxy services...': '正在載入反向代理服務…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      '由清單檔描述的本機反向代理服務，及其接入的渠道與內嵌面板。',
    Manifest: '清單檔',
    'Manifest directory': '清單目錄',
    'Manifest errors': '清單載入錯誤',
    'Manifests reloaded': '清單已重新載入',
    'No log output yet.': '尚無日誌輸出。',
    'No reverse proxy services found.': '未發現反向代理服務。',
    'Not built yet': '尚未建置',
    PID: 'PID',
    Panel: '面板',
    'Panel failed to load.': '面板載入失敗。',
    'Panel unavailable': '面板無法使用',
    'Register channel': '註冊渠道',
    'Reload manifests': '重新載入清單',
    Restart: '重新啟動',
    'Reverse Proxy': '反向代理',
    'Reverse proxy service panel': '反向代理服務面板',
    'Service API key': '服務 API 金鑰',
    'Service log · auto-refreshing every {{seconds}}s':
      '服務日誌 · 每 {{seconds}} 秒自動更新',
    'Service panel': '服務面板',
    'Service restarted': '服務已重新啟動',
    'Service started': '服務已啟動',
    'Service stopped': '服務已停止',
    Services: '服務',
    Stopped: '已停止',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      '內嵌面板會自動取得此金鑰，僅在供其他用戶端使用時才需要複製。',
    Unhealthy: '運作異常',
    'We could not load reverse proxy services.': '無法載入反向代理服務。',
    'We could not load the service log.': '無法載入服務日誌。',
    'We could not read the service API key.': '無法讀取服務 API 金鑰。',
    Workdir: '工作目錄',
  },
  fr: {
    "Model prefix": "Préfixe de modèle",
    "None": "Aucun",
    Build: 'Compiler',
    'Build finished': 'Compilation terminée',
    'Channel registered': 'Canal enregistré',
    'Copy panel URL': "Copier l'URL du panneau",
    'Drop a JSON manifest into the services directory and reload.':
      'Déposez un manifeste JSON dans le répertoire des services puis rechargez.',
    'Loading logs...': 'Chargement des journaux…',
    'Loading panel...': 'Chargement du panneau…',
    'Loading reverse proxy services...':
      'Chargement des services de proxy inverse…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      'Services de proxy inverse locaux décrits par des manifestes, avec leurs canaux relais et leurs panneaux.',
    Manifest: 'Manifeste',
    'Manifest directory': 'Répertoire des manifestes',
    'Manifest errors': 'Erreurs de manifeste',
    'Manifests reloaded': 'Manifestes rechargés',
    'No log output yet.': 'Aucune sortie de journal pour le moment.',
    'No reverse proxy services found.': 'Aucun service de proxy inverse trouvé.',
    'Not built yet': 'Pas encore compilé',
    PID: 'PID',
    Panel: 'Panneau',
    'Panel failed to load.': 'Échec du chargement du panneau.',
    'Panel unavailable': 'Panneau indisponible',
    'Register channel': 'Enregistrer le canal',
    'Reload manifests': 'Recharger les manifestes',
    Restart: 'Redémarrer',
    'Reverse Proxy': 'Proxy inverse',
    'Reverse proxy service panel': 'Panneau du service de proxy inverse',
    'Service API key': 'Clé API du service',
    'Service log · auto-refreshing every {{seconds}}s':
      'Journal du service · actualisation automatique toutes les {{seconds}} s',
    'Service panel': 'Panneau du service',
    'Service restarted': 'Service redémarré',
    'Service started': 'Service démarré',
    'Service stopped': 'Service arrêté',
    Services: 'Services',
    Stopped: 'Arrêté',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      "Le panneau intégré reçoit cette clé automatiquement ; ne la copiez que pour d'autres clients.",
    Unhealthy: 'En anomalie',
    'We could not load reverse proxy services.':
      'Impossible de charger les services de proxy inverse.',
    'We could not load the service log.':
      'Impossible de charger le journal du service.',
    'We could not read the service API key.':
      "Impossible de lire la clé API du service.",
    Workdir: 'Répertoire de travail',
  },
  ja: {
    "Model prefix": "モデル接頭辞",
    "None": "なし",
    Build: 'ビルド',
    'Build finished': 'ビルド完了',
    'Channel registered': 'チャネルを登録しました',
    'Copy panel URL': 'パネルURLをコピー',
    'Drop a JSON manifest into the services directory and reload.':
      'サービスディレクトリに JSON マニフェストを配置して再読み込みしてください。',
    'Loading logs...': 'ログを読み込み中…',
    'Loading panel...': 'パネルを読み込み中…',
    'Loading reverse proxy services...': 'リバースプロキシサービスを読み込み中…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      'マニフェストで定義されたローカルリバースプロキシサービスと、その中継チャネル・パネル。',
    Manifest: 'マニフェスト',
    'Manifest directory': 'マニフェストディレクトリ',
    'Manifest errors': 'マニフェストのエラー',
    'Manifests reloaded': 'マニフェストを再読み込みしました',
    'No log output yet.': 'まだログ出力はありません。',
    'No reverse proxy services found.':
      'リバースプロキシサービスが見つかりません。',
    'Not built yet': '未ビルド',
    PID: 'PID',
    Panel: 'パネル',
    'Panel failed to load.': 'パネルの読み込みに失敗しました。',
    'Panel unavailable': 'パネルを利用できません',
    'Register channel': 'チャネルを登録',
    'Reload manifests': 'マニフェストを再読み込み',
    Restart: '再起動',
    'Reverse Proxy': 'リバースプロキシ',
    'Reverse proxy service panel': 'リバースプロキシサービスのパネル',
    'Service API key': 'サービスAPIキー',
    'Service log · auto-refreshing every {{seconds}}s':
      'サービスログ · {{seconds}} 秒ごとに自動更新',
    'Service panel': 'サービスのパネル',
    'Service restarted': 'サービスを再起動しました',
    'Service started': 'サービスを起動しました',
    'Service stopped': 'サービスを停止しました',
    Services: 'サービス',
    Stopped: '停止中',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      '埋め込みパネルはこのキーを自動的に受け取ります。コピーが必要なのは他のクライアントで使う場合のみです。',
    Unhealthy: '異常',
    'We could not load reverse proxy services.':
      'リバースプロキシサービスを読み込めませんでした。',
    'We could not load the service log.':
      'サービスログを読み込めませんでした。',
    'We could not read the service API key.':
      'サービスAPIキーを読み取れませんでした。',
    Workdir: '作業ディレクトリ',
  },
  ru: {
    "Model prefix": "Префикс модели",
    "None": "Нет",
    Build: 'Сборка',
    'Build finished': 'Сборка завершена',
    'Channel registered': 'Канал зарегистрирован',
    'Copy panel URL': 'Копировать URL панели',
    'Drop a JSON manifest into the services directory and reload.':
      'Поместите JSON-манифест в каталог сервисов и перезагрузите.',
    'Loading logs...': 'Загрузка журналов…',
    'Loading panel...': 'Загрузка панели…',
    'Loading reverse proxy services...':
      'Загрузка сервисов обратного прокси…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      'Локальные сервисы обратного прокси, описанные манифестами, с их каналами и панелями.',
    Manifest: 'Манифест',
    'Manifest directory': 'Каталог манифестов',
    'Manifest errors': 'Ошибки манифеста',
    'Manifests reloaded': 'Манифесты перезагружены',
    'No log output yet.': 'Журнал пока пуст.',
    'No reverse proxy services found.': 'Сервисы обратного прокси не найдены.',
    'Not built yet': 'Ещё не собрано',
    PID: 'PID',
    Panel: 'Панель',
    'Panel failed to load.': 'Не удалось загрузить панель.',
    'Panel unavailable': 'Панель недоступна',
    'Register channel': 'Зарегистрировать канал',
    'Reload manifests': 'Перезагрузить манифесты',
    Restart: 'Перезапустить',
    'Reverse Proxy': 'Обратный прокси',
    'Reverse proxy service panel': 'Панель сервиса обратного прокси',
    'Service API key': 'Ключ API сервиса',
    'Service log · auto-refreshing every {{seconds}}s':
      'Журнал сервиса · автообновление каждые {{seconds}} с',
    'Service panel': 'Панель сервиса',
    'Service restarted': 'Сервис перезапущен',
    'Service started': 'Сервис запущен',
    'Service stopped': 'Сервис остановлен',
    Services: 'Сервисы',
    Stopped: 'Остановлен',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      'Встроенная панель получает этот ключ автоматически; копируйте его только для других клиентов.',
    Unhealthy: 'Сбой',
    'We could not load reverse proxy services.':
      'Не удалось загрузить сервисы обратного прокси.',
    'We could not load the service log.':
      'Не удалось загрузить журнал сервиса.',
    'We could not read the service API key.':
      'Не удалось прочитать ключ API сервиса.',
    Workdir: 'Рабочий каталог',
  },
  vi: {
    "Model prefix": "Tiền tố mô hình",
    "None": "Không",
    Build: 'Biên dịch',
    'Build finished': 'Biên dịch hoàn tất',
    'Channel registered': 'Đã đăng ký kênh',
    'Copy panel URL': 'Sao chép URL bảng điều khiển',
    'Drop a JSON manifest into the services directory and reload.':
      'Thả tệp kê khai JSON vào thư mục dịch vụ rồi tải lại.',
    'Loading logs...': 'Đang tải nhật ký…',
    'Loading panel...': 'Đang tải bảng điều khiển…',
    'Loading reverse proxy services...': 'Đang tải dịch vụ proxy ngược…',
    'Local reverse proxy services described by manifests, with their relay channels and panels.':
      'Dịch vụ proxy ngược cục bộ được mô tả bằng tệp kê khai, cùng kênh trung chuyển và bảng điều khiển.',
    Manifest: 'Tệp kê khai',
    'Manifest directory': 'Thư mục kê khai',
    'Manifest errors': 'Lỗi tệp kê khai',
    'Manifests reloaded': 'Đã tải lại tệp kê khai',
    'No log output yet.': 'Chưa có nhật ký.',
    'No reverse proxy services found.': 'Không tìm thấy dịch vụ proxy ngược nào.',
    'Not built yet': 'Chưa biên dịch',
    PID: 'PID',
    Panel: 'Bảng điều khiển',
    'Panel failed to load.': 'Tải bảng điều khiển thất bại.',
    'Panel unavailable': 'Bảng điều khiển không khả dụng',
    'Register channel': 'Đăng ký kênh',
    'Reload manifests': 'Tải lại tệp kê khai',
    Restart: 'Khởi động lại',
    'Reverse Proxy': 'Proxy ngược',
    'Reverse proxy service panel': 'Bảng điều khiển dịch vụ proxy ngược',
    'Service API key': 'Khóa API dịch vụ',
    'Service log · auto-refreshing every {{seconds}}s':
      'Nhật ký dịch vụ · tự động làm mới mỗi {{seconds}} giây',
    'Service panel': 'Bảng điều khiển dịch vụ',
    'Service restarted': 'Đã khởi động lại dịch vụ',
    'Service started': 'Đã khởi động dịch vụ',
    'Service stopped': 'Đã dừng dịch vụ',
    Services: 'Dịch vụ',
    Stopped: 'Đã dừng',
    'The embedded panel receives this key automatically; copy it only for other clients.':
      'Bảng điều khiển nhúng tự nhận khóa này; chỉ sao chép khi dùng cho ứng dụng khác.',
    Unhealthy: 'Bất thường',
    'We could not load reverse proxy services.':
      'Không thể tải dịch vụ proxy ngược.',
    'We could not load the service log.': 'Không thể tải nhật ký dịch vụ.',
    'We could not read the service API key.':
      'Không thể đọc khóa API dịch vụ.',
    Workdir: 'Thư mục làm việc',
  },
}

async function main() {
  let totalAdded = 0

  for (const [locale, trans] of Object.entries(newKeys)) {
    const filePath = path.join(LOCALES_DIR, `${locale}.json`)
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'))

    let count = 0
    for (const [key, value] of Object.entries(trans)) {
      if (!Object.prototype.hasOwnProperty.call(json.translation, key)) {
        json.translation[key] = value
        count++
      } else if (json.translation[key] !== value) {
        json.translation[key] = value
        count++
      }
    }

    if (count > 0) {
      json.translation = Object.fromEntries(
        Object.entries(json.translation).sort(([a], [b]) => a.localeCompare(b))
      )
      await fs.writeFile(filePath, stableStringify(json), 'utf8')
    }

    console.log(`${locale}: ${count} translations applied`)
    totalAdded += count
  }

  console.log(`\nTotal: ${totalAdded} translations applied`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
