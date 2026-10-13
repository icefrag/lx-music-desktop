// ts-loader 按依赖图构建编译程序，全局声明文件需显式引用才能并入
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../common/types/account_source.d.ts" />
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { sendEvent } from '@main/modules/winMain/main'
import { ACCOUNT_SOURCE_PLATFORMS, PLATFORM_CONFIGS } from './const'
import { AuthExpiredError, NoSourceError } from './errors'
import { cancelLogin, openLogin } from './loginWin'
import { resolvers } from './resolvers'
import { clearSession, hasLoginCookie } from './sessions'
import { getStatus, setStatusBroadcast, updateStatus } from './status'

const assertPlatform = (platform: LX.AccountSource.Platform) => {
  if (!ACCOUNT_SOURCE_PLATFORMS.includes(platform)) throw new Error(`不支持的音乐源: ${platform}`)
}

export const login = async(platform: LX.AccountSource.Platform) => {
  await openLogin(platform)
  // 登录窗口关闭后立即校验凭证有效性
  try {
    const result = await resolvers[platform].validate()
    const patch: Partial<LX.AccountSource.Status> = { login: true, status: 'ok', message: undefined }
    // 校验接口可能拿不到昵称，避免覆盖既有值
    if (result.nickname) patch.nickname = result.nickname
    updateStatus(platform, patch)
  } catch (err: any) {
    const expired = err instanceof AuthExpiredError
    updateStatus(platform, {
      login: true,
      status: expired ? 'expired' : 'unknown',
      message: err.message,
    })
  }
  return getStatus()
}

export const loginCancel = () => {
  cancelLogin()
}

export const logout = async(platform: LX.AccountSource.Platform) => {
  cancelLogin()
  await clearSession(platform)
  updateStatus(platform, { login: false, status: 'unknown', nickname: undefined, message: undefined })
  return getStatus()
}

// tx 侧“无 purl”可能是凭证失效也可能是歌曲无版权，用校验接口静默复核，避免误标/漏标
let lastRevalidateAt: Partial<Record<LX.AccountSource.Platform, number>> = {}
const revalidateQuietly = (platform: LX.AccountSource.Platform) => {
  if (Date.now() - (lastRevalidateAt[platform] ?? 0) < 5 * 60 * 1000) return
  lastRevalidateAt[platform] = Date.now()
  void resolvers[platform].validate().then(result => {
    const patch: Partial<LX.AccountSource.Status> = { login: true, status: result.ok ? 'ok' : 'expired' }
    if (result.nickname) patch.nickname = result.nickname
    updateStatus(platform, patch)
  }).catch((err: any) => {
    updateStatus(platform, { login: true, status: err instanceof AuthExpiredError ? 'expired' : 'unknown', message: err.message })
  })
}

export const requestUrl = async({ source, type, musicInfo }: LX.AccountSource.UrlRequestParams) => {
  if (!ACCOUNT_SOURCE_PLATFORMS.includes(source)) throw new Error(`不支持的音乐源: ${source}`)
  if (!await hasLoginCookie(source)) throw new Error(`未登录${PLATFORM_CONFIGS[source].name}`)
  try {
    return { url: await resolvers[source].getMusicUrl(musicInfo, type) }
  } catch (err: any) {
    // 诊断日志：真机验证期观察解析失败原因，稳定后移除
    console.log(`[account-source:${source}] 解析失败(${type}):`, err.message)
    if (err instanceof AuthExpiredError) {
      updateStatus(source, { login: true, status: 'expired', message: err.message })
      // 跨 IPC 只保留 message，用稳定前缀让下载/播放侧识别凭证失效（归类 account_expired）
      throw new Error(`account_expired: ${err.message}`)
    } else if (err instanceof NoSourceError) {
      revalidateQuietly(source)
    }
    throw err
  }
}

const initStatus = async() => {
  for (const platform of ACCOUNT_SOURCE_PLATFORMS) {
    updateStatus(platform, { login: await hasLoginCookie(platform) })
  }
}

export default () => {
  setStatusBroadcast(status => {
    sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.account_source_status, status)
  })

  mainHandle<LX.AccountSource.StatusMap>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_get_status, async() => {
    return getStatus()
  })

  mainHandle<LX.AccountSource.Platform, LX.AccountSource.StatusMap>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_login, async({ params: platform }) => {
    assertPlatform(platform)
    return login(platform)
  })

  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.account_source_login_cancel, async() => {
    loginCancel()
  })

  mainHandle<LX.AccountSource.Platform, LX.AccountSource.StatusMap>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_logout, async({ params: platform }) => {
    assertPlatform(platform)
    return logout(platform)
  })

  mainHandle<LX.AccountSource.UrlRequestParams, LX.AccountSource.UrlResult>(WIN_MAIN_RENDERER_EVENT_NAME.account_source_request_url, async({ params }) => {
    return requestUrl(params)
  })

  void initStatus()
}
