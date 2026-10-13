import { BrowserWindow } from 'electron'
import { PLATFORM_CONFIGS } from './const'
import { getSession, watchLoginCookie } from './sessions'

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
  if (!task) return
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
  // 关键 cookie 已出现，稍等其余 cookie 落地再收网
  task.captureTimer = setTimeout(() => {
    pending = null
    task.cleanup()
    closeWindow()
    task.resolve(cookieName)
  }, 1500)
}

const cancelPending = (err: Error) => {
  const task = pending
  if (!task) return
  pending = null
  if (task.captureTimer) clearTimeout(task.captureTimer)
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
  task.cleanup()
  closeWindow()
  task.reject(err)
}

export const openLogin = async(platform: LX.AccountSource.Platform) => {
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

    void window.loadURL(config.loginUrl)
  })
}

export const cancelLogin = () => {
  cancelPending(new Error('已取消'))
}
