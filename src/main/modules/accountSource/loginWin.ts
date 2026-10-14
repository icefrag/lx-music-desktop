import { BrowserWindow } from 'electron'
import { PLATFORM_CONFIGS } from './const'
import { clearSession, getLoginCookie, getSession, watchLoginCookie } from './sessions'
import log from './log'

let loginWindow: BrowserWindow | null = null
let pending: {
  platform: LX.AccountSource.Platform
  resolve: (cookieName: string) => void
  reject: (err: Error) => void
  cleanup: () => void
  captureTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
} | null = null

// 登录窗口停留过久时自动收尾，避免 Promise 悬挂、设置页按钮一直禁用
const LOGIN_TIMEOUT = 5 * 60 * 1000

const closeWindow = () => {
  loginWindow?.destroy()
  loginWindow = null
}

const settle = (cookieName: string) => {
  const task = pending
  if (!task || task.captureTimer) return
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
  // 诊断日志：真机验证期观察登录捕获，稳定后移除
  log.info(`[account-source:${task.platform}] 登录窗捕获 cookie: ${cookieName}，1.5s 后收网`)
  // 关键 cookie 已出现，稍等其余 cookie 落地再收网
  task.captureTimer = setTimeout(() => {
    pending = null
    task.cleanup()
    closeWindow()
    // Chromium 对分区 cookie 的刷盘不及时，实测退出前都不落盘；登录后显式刷一次，避免应用重启丢登录
    void getSession(task.platform).cookies.flushStore().catch(() => {})
    task.resolve(cookieName)
  }, 1500)
}

const cancelPending = (err: Error) => {
  const task = pending
  if (!task) return
  pending = null
  // 诊断日志：真机验证期观察登录收尾原因，稳定后移除
  log.info(`[account-source:${task.platform}] 登录流程结束: ${err.message}`)
  if (task.captureTimer) clearTimeout(task.captureTimer)
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
  task.cleanup()
  closeWindow()
  task.reject(err)
}

export const openLogin = async(platform: LX.AccountSource.Platform, opts: { force?: boolean } = {}) => {
  // force（重新登录）：旧 token 已被服务端判定失效，清掉分区会话让页面必然呈现登录表单，
  // 重新登录 = 真正的重新认证；清空后走常规捕获流程（新登录 cookie 出现即自动收网）
  if (opts.force) await clearSession(platform)
  return new Promise<string>((resolve, reject) => {
    cancelPending(new Error('已取消'))

    const config = PLATFORM_CONFIGS[platform]
    const unwatch = watchLoginCookie(platform, settle)

    const window = new BrowserWindow({
      width: 1024,
      height: 720,
      show: true,
      autoHideMenuBar: true,
      title: `登录${config.name}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        session: getSession(platform),
      },
    })

    // 平台 SSO 弹窗（如 QQ 快捷登录）必须留在同分区会话内打开，cookie 才能被捕获；
    // 覆盖 app.ts 的全局 openExternal 策略仅限本窗口
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: getSession(platform) } } }
      }
      return { action: 'deny' }
    })

    loginWindow = window
    pending = {
      platform,
      resolve,
      reject,
      cleanup: unwatch,
      captureTimer: null,
      timeoutTimer: setTimeout(() => {
        cancelPending(new Error('登录超时，请重试'))
      }, LOGIN_TIMEOUT),
    }

    window.on('closed', () => {
      if (loginWindow == window) loginWindow = null
      cancelPending(new Error('登录窗口已关闭'))
    })

    // 已登录会话下打开登录页不会再触发 cookie 变化，加载完成后主动检测一次，
    // 否则 Promise 一直挂到超时，用户只能手动关窗（报“登录窗口已关闭”）
    window.webContents.on('did-finish-load', () => {
      void getLoginCookie(platform).then(cookie => {
        if (cookie) settle(cookie.name)
      })
    })

    void window.loadURL(config.loginUrl)
  })
}

export const cancelLogin = () => {
  cancelPending(new Error('已取消'))
}
