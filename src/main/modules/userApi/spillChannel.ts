// 三方通道沙箱（ADR 0005）：常驻第二个 user-api 沙箱页，固定加载内置野花脚本，
// 供下载双通道分发器定点解析（preload 经 --lx-spill-channel 打 scope 标签与生效音源沙箱隔离）。
// 懒创建：首次溢出请求时拉起并常驻；与当前生效音源沙箱互不影响（代理变更不随动，创建时取一次）。
import { mainHandle, mainSend } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'node:path'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { getProxy } from './main'
import { getScript, getUserApis } from './utils'

export const SPILL_API_ID = 'user_api_builtin_yehua'

const INIT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 20_000

const denyEvents = [
  'will-navigate',
  'will-redirect',
  'will-attach-webview',
  'will-prevent-unload',
  'media-started-playing',
] as const

let browserWindow: Electron.BrowserWindow | null = null
let html: string | null = null
let pendingInit: Promise<void> | null = null
let initResolve: (() => void) | null = null
let initReject: ((err: Error) => void) | null = null
const requestQueue = new Map<string, [(result: any) => void, (err: Error) => void]>()
const timeouts = new Map<string, NodeJS.Timeout>()

export const handleSpillInit = ({ status, message }: { status: boolean, message?: string }) => {
  if (status) initResolve?.()
  else initReject?.(new Error(message ?? '三方通道脚本初始化失败'))
  initResolve = null
  initReject = null
}

export const handleSpillResponse = ({ status, message, data }: { status: boolean, message?: string, data: { requestKey: string, result: any } }) => {
  const request = requestQueue.get(data.requestKey)
  if (!request) return
  requestQueue.delete(data.requestKey)
  const timeout = timeouts.get(data.requestKey)
  if (timeout) {
    clearTimeout(timeout)
    timeouts.delete(data.requestKey)
  }
  if (status) request[0](data.result)
  else request[1](new Error(message ?? '三方通道请求失败'))
}

const createSpillWindow = async() => {
  const api = getUserApis().find(a => a.id == SPILL_API_ID)
  if (!api) throw new Error('内置三方音源不存在')
  const dir = process.env.NODE_ENV !== 'production' ? webpackUserApiPath : path.join(__dirname, 'userApi')
  html ??= await fs.promises.readFile(path.join(dir, 'renderer/user-api.html'), 'utf8')
  const preloadUrl = process.env.NODE_ENV !== 'production'
    ? path.join(__dirname, '../dist/user-api-preload.js')
    : path.join(__dirname, 'user-api-preload.js')

  browserWindow = new BrowserWindow({
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
      enableWebSQL: false,
      disableDialogs: true,
      webgl: false,
      images: false,
      preload: preloadUrl,
      additionalArguments: ['--lx-spill-channel'],
    },
  })

  for (const eventName of denyEvents) {
    // @ts-expect-error
    browserWindow.webContents.on(eventName, (event: Electron.Event) => {
      event.preventDefault()
    })
  }
  browserWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })
  browserWindow.on('closed', () => {
    browserWindow = null
  })

  await browserWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))

  browserWindow.once('ready-to-show', async() => {
    const target = browserWindow
    if (!target) return
    mainSend(target, USER_API_RENDERER_EVENT_NAME.initEnv, { ...api, script: await getScript(api.id), proxy: getProxy() })
  })
}

const closeSpillWindow = async() => {
  for (const [requestKey, request] of requestQueue) {
    request[1](new Error('三方通道已关闭'))
    const timeout = timeouts.get(requestKey)
    if (timeout) clearTimeout(timeout)
  }
  requestQueue.clear()
  timeouts.clear()
  initReject?.(new Error('三方通道已关闭'))
  initResolve = null
  initReject = null
  if (!browserWindow) return
  const win = browserWindow
  browserWindow = null
  await win.webContents.session.clearCache().catch(() => {})
  win.destroy()
}

const waitSpillInit = () => new Promise<void>((resolve, reject) => {
  initResolve = resolve
  initReject = reject
  const timer = setTimeout(() => {
    initReject?.(new Error('三方通道脚本初始化超时'))
  }, INIT_TIMEOUT_MS)
  timer.unref?.()
})

const ensureSpillChannel = async() => {
  if (browserWindow) return
  if (pendingInit) return pendingInit
  pendingInit = (async() => {
    await createSpillWindow()
    await waitSpillInit()
  })()
  try {
    await pendingInit
  } catch (err) {
    await closeSpillWindow()
    throw err
  } finally {
    pendingInit = null
  }
}

const spillRequest = async(data: { source: string, action: string, info: { type: string, musicInfo: any } }): Promise<any> => {
  const win = browserWindow
  if (!win) throw new Error('三方通道未就绪')
  const requestKey = `spill__${Math.random().toString().substring(2)}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const request = requestQueue.get(requestKey)
      requestQueue.delete(requestKey)
      request?.[1](new Error('三方通道请求超时'))
    }, REQUEST_TIMEOUT_MS)
    timeouts.set(requestKey, timeout)
    requestQueue.set(requestKey, [resolve, reject])
    mainSend(win, USER_API_RENDERER_EVENT_NAME.request, { requestKey, data })
  })
}

export const spillUrl = async({ source, type, musicInfo }: LX.AccountSource.UrlRequestParams): Promise<LX.AccountSource.UrlResult> => {
  await ensureSpillChannel()
  const result = await spillRequest({ source, action: 'musicUrl', info: { type, musicInfo } })
  // preload 已校验 musicUrl 为 http(s) 字符串
  return { url: result.data.url }
}

export default () => {
  mainHandle<LX.AccountSource.UrlRequestParams, LX.AccountSource.UrlResult>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_spill_url, async({ params }) => spillUrl(params))
}
