// ts-loader 按依赖图构建编译程序，全局声明文件需显式引用才能并入
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../common/types/account_source.d.ts" />
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { sendEvent } from '@main/modules/winMain/main'
import { ACCOUNT_SOURCE_PLATFORMS, PLATFORM_CONFIGS } from './const'
import { AuthExpiredError, NoSourceError, RiskControlError } from './errors'
import { cancelLogin, openLogin } from './loginWin'
import { isCoolingDown, runThrottled } from './queue'
import { resolvers } from './resolvers'
import { clearSession, hasLoginCookie } from './sessions'
import log from './log'
import { getStatus, setStatusBroadcast, updateStatus } from './status'

const assertPlatform = (platform: LX.AccountSource.Platform) => {
  if (!ACCOUNT_SOURCE_PLATFORMS.includes(platform)) throw new Error(`不支持的音乐源: ${platform}`)
}

// 校验单个平台凭证并更新状态（登录后与启动时共用）
const validateAndUpdate = async(platform: LX.AccountSource.Platform) => {
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
}

export const login = async(platform: LX.AccountSource.Platform) => {
  await openLogin(platform)
  // 登录窗口关闭后立即校验凭证有效性
  await validateAndUpdate(platform)
  // 诊断日志：真机验证期观察登录后状态，稳定后移除
  const status = getStatus()[platform]
  log.info(`[account-source:${platform}] 登录完成: login=${status.login} status=${status.status} ${status.message ?? ''}`)
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
  // 风控冷却期快速失败（不占队列、不碰平台）；稳定前缀供下载侧挂起等待而非降级
  if (isCoolingDown(source)) throw new Error(`risk_control: ${PLATFORM_CONFIGS[source].name}账号冷却中(风控触发)`)
  if (!await hasLoginCookie(source)) {
    // 诊断日志：链路未触发（cookie 未捕获）与 resolver 报错需可区分
    log.info(`[account-source:${source}] 跳过：登录 cookie 未捕获，走兜底链`)
    throw new Error(`未登录${PLATFORM_CONFIGS[source].name}`)
  }
  try {
    return { url: await runThrottled(source, async() => resolvers[source].getMusicUrl(musicInfo, type)) }
  } catch (err: any) {
    // 诊断日志：真机验证期观察解析失败原因，稳定后移除
    console.log(`[account-source:${source}] 解析失败(${type}):`, err.message)
    if (err instanceof AuthExpiredError) {
      updateStatus(source, { login: true, status: 'expired', message: err.message })
      // 跨 IPC 只保留 message，用稳定前缀让下载/播放侧识别凭证失效（归类 account_expired）
      throw new Error(`account_expired: ${err.message}`)
    } else if (err instanceof RiskControlError) {
      // 冷却已在队列内设置并广播；前缀供下载侧挂起等待，播放侧收到后照常即时回落
      throw new Error(`risk_control: ${err.message}`)
    } else if (err instanceof NoSourceError) {
      revalidateQuietly(source)
    }
    throw err
  }
}

const initStatus = async() => {
  for (const platform of ACCOUNT_SOURCE_PLATFORMS) {
    const login = await hasLoginCookie(platform)
    // 诊断日志：真机验证期观察启动判定，稳定后移除
    log.info(`[account-source:${platform}] 启动判定 login=${login}`)
    updateStatus(platform, { login })
  }
  // 启动时对已有登录态的平台自动校验一次，状态不再停留在“待校验”
  // 探针走同平台队列节流，避免紧跟下载解析连发触发频率风控；冷却中的平台直接跳过（发也白发）
  await Promise.all(ACCOUNT_SOURCE_PLATFORMS.filter(platform => getStatus()[platform].login).map(async platform => {
    if (isCoolingDown(platform)) return
    await runThrottled(platform, () => validateAndUpdate(platform))
  }))
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
