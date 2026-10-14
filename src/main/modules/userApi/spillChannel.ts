// 三方通道沙箱池（ADR 0006）：每个池成员一个常驻懒创建的 user-api 隐藏页，
// 供下载分发器定点解析（preload 经 --lx-spill-channel=<成员id> 打 scope 标签与生效音源沙箱隔离）。
// 懒创建：成员首次请求时拉起并常驻，空闲 10 分钟销毁；与当前生效音源沙箱互不影响（代理变更不随动，创建时取一次）。
// 成员 init 成功后向渲染层广播其「平台×音质」能力表，供分发器按（平台×128k）过滤候选。
import { mainHandle, mainSend } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'node:path'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { getProxy } from './main'
import { getScript, getUserApis } from './utils'
import { sendPoolMemberInfo } from '@main/modules/winMain/rendererEvent/userApi'

export const SPILL_API_ID = 'user_api_builtin_yehua'

const INIT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 20_000
const IDLE_TEARDOWN_MS = 10 * 60 * 1000

const denyEvents = [
  'will-navigate',
  'will-redirect',
  'will-attach-webview',
  'will-prevent-unload',
  'media-started-playing',
] as const

interface MemberChannel {
  id: string
  browserWindow: Electron.BrowserWindow | null
  pendingInit: Promise<void> | null
  initResolve: (() => void) | null
  initReject: ((err: Error) => void) | null
  requestQueue: Map<string, [(result: any) => void, (err: Error) => void]>
  timeouts: Map<string, NodeJS.Timeout>
  idleTimer: NodeJS.Timeout | null
}

const members = new Map<string, MemberChannel>()
let html: string | null = null

const createChannel = (id: string): MemberChannel => {
  const channel: MemberChannel = {
    id,
    browserWindow: null,
    pendingInit: null,
    initResolve: null,
    initReject: null,
    requestQueue: new Map(),
    timeouts: new Map(),
    idleTimer: null,
  }
  members.set(id, channel)
  return channel
}

const rejectAllRequests = (channel: MemberChannel, message: string) => {
  for (const [requestKey, request] of channel.requestQueue) {
    request[1](new Error(message))
    const timeout = channel.timeouts.get(requestKey)
    if (timeout) clearTimeout(timeout)
  }
  channel.requestQueue.clear()
  channel.timeouts.clear()
  channel.initReject?.(new Error(message))
  channel.initResolve = null
  channel.initReject = null
}

const closeChannel = async(channel: MemberChannel) => {
  if (channel.idleTimer) {
    clearTimeout(channel.idleTimer)
    channel.idleTimer = null
  }
  rejectAllRequests(channel, '三方通道成员已关闭')
  if (!channel.browserWindow) return
  const win = channel.browserWindow
  channel.browserWindow = null
  await win.webContents.session.clearCache().catch(() => {})
  win.destroy()
}

const armIdleTeardown = (channel: MemberChannel) => {
  if (channel.idleTimer) clearTimeout(channel.idleTimer)
  channel.idleTimer = setTimeout(() => {
    channel.idleTimer = null
    void closeChannel(channel)
  }, IDLE_TEARDOWN_MS)
  channel.idleTimer.unref?.()
}

export const handlePoolInit = (memberId: string, { status, message, data }: { status: boolean, message?: string, data?: any }) => {
  const channel = members.get(memberId)
  if (!channel) return
  if (status) {
    channel.initResolve?.()
    // 能力表推给渲染层：分发器按（平台×音质）过滤候选；data 为 preload handleInit 的 sourceInfo
    if (data?.sources) {
      const api = getUserApis().find(a => a.id == memberId)
      sendPoolMemberInfo({ id: memberId, name: api?.name ?? memberId, sources: data.sources })
    }
  } else {
    channel.initReject?.(new Error(message ?? '三方通道脚本初始化失败'))
  }
  channel.initResolve = null
  channel.initReject = null
}

export const handlePoolResponse = (memberId: string, { status, message, data }: { status: boolean, message?: string, data: { requestKey: string, result: any } }) => {
  const channel = members.get(memberId)
  if (!channel) return
  const request = channel.requestQueue.get(data.requestKey)
  if (!request) return
  channel.requestQueue.delete(data.requestKey)
  const timeout = channel.timeouts.get(data.requestKey)
  if (timeout) {
    clearTimeout(timeout)
    channel.timeouts.delete(data.requestKey)
  }
  if (status) request[0](data.result)
  else request[1](new Error(message ?? '三方通道请求失败'))
}

const createMemberWindow = async(channel: MemberChannel) => {
  const api = getUserApis().find(a => a.id == channel.id)
  if (!api) throw new Error('三方通道成员不存在: ' + channel.id)
  const dir = process.env.NODE_ENV !== 'production' ? webpackUserApiPath : path.join(__dirname, 'userApi')
  // eslint-disable-next-line require-atomic-updates
  html ??= await fs.promises.readFile(path.join(dir, 'renderer/user-api.html'), 'utf8')
  const preloadUrl = process.env.NODE_ENV !== 'production'
    ? path.join(__dirname, '../dist/user-api-preload.js')
    : path.join(__dirname, 'user-api-preload.js')

  channel.browserWindow = new BrowserWindow({
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
      additionalArguments: ['--lx-spill-channel=' + channel.id],
    },
  })

  for (const eventName of denyEvents) {
    // @ts-expect-error
    channel.browserWindow.webContents.on(eventName, (event: Electron.Event) => {
      event.preventDefault()
    })
  }
  channel.browserWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })
  channel.browserWindow.on('closed', () => {
    channel.browserWindow = null
  })

  await channel.browserWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))

  channel.browserWindow.once('ready-to-show', async() => {
    const target = channel.browserWindow
    if (!target) return
    mainSend(target, USER_API_RENDERER_EVENT_NAME.initEnv, { ...api, script: await getScript(api.id), proxy: getProxy() })
  })
}

const waitChannelInit = async(channel: MemberChannel) => new Promise<void>((resolve, reject) => {
  channel.initResolve = resolve
  channel.initReject = reject
  const timer = setTimeout(() => {
    reject(new Error('三方通道脚本初始化超时'))
  }, INIT_TIMEOUT_MS)
  timer.unref?.()
})

const ensureChannel = async(channel: MemberChannel) => {
  if (channel.browserWindow) return
  if (channel.pendingInit) return channel.pendingInit
  channel.pendingInit = (async() => {
    await createMemberWindow(channel)
    await waitChannelInit(channel)
  })()
  try {
    await channel.pendingInit
  } catch (err) {
    await closeChannel(channel)
    throw err
  } finally {
    channel.pendingInit = null
  }
}

const memberRequest = async(channel: MemberChannel, data: { source: string, action: string, info: { type: string, musicInfo: any } }): Promise<any> => {
  const win = channel.browserWindow
  if (!win) throw new Error('三方通道成员未就绪')
  const requestKey = `spill__${Math.random().toString().substring(2)}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const request = channel.requestQueue.get(requestKey)
      channel.requestQueue.delete(requestKey)
      channel.timeouts.delete(requestKey)
      request?.[1](new Error('三方通道请求超时'))
    }, REQUEST_TIMEOUT_MS)
    channel.timeouts.set(requestKey, timeout)
    channel.requestQueue.set(requestKey, [resolve, reject])
    mainSend(win, USER_API_RENDERER_EVENT_NAME.request, { requestKey, data })
  })
}

export const spillUrl = async({ memberId, source, type, musicInfo }: LX.AccountSource.UrlRequestParams): Promise<LX.AccountSource.UrlResult> => {
  const channel = members.get(memberId) ?? createChannel(memberId)
  if (channel.idleTimer) {
    clearTimeout(channel.idleTimer)
    channel.idleTimer = null
  }
  try {
    await ensureChannel(channel)
    const result = await memberRequest(channel, { source, action: 'musicUrl', info: { type, musicInfo } })
    // preload 已校验 musicUrl 为 http(s) 字符串
    return { url: result.data.url }
  } finally {
    // 有在途请求时不武装空闲销毁（memberRequest 已结束，仅剩排队场景由下一轮请求继续延迟）
    if (channel.requestQueue.size == 0) armIdleTeardown(channel)
  }
}

export const closePoolChannels = async(ids: string[]) => {
  for (const id of ids) {
    const channel = members.get(id)
    if (!channel) continue
    members.delete(id)
    await closeChannel(channel)
  }
}

export default () => {
  mainHandle<LX.AccountSource.UrlRequestParams, LX.AccountSource.UrlResult>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_spill_url, async({ params }) => spillUrl(params))
}
