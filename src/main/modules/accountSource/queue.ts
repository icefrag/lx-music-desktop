// ts-loader 按依赖图构建编译程序，全局声明文件需显式引用才能并入
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../common/types/account_source.d.ts" />
import { RiskControlError } from './errors'

// 各平台解析请求的最小间隔（秒）：保护账号不被平台风控限流，设置页可调，0 为不限速
const COOLDOWN_BASE_MS = 10 * 60 * 1000
const COOLDOWN_MAX_MS = 60 * 60 * 1000

interface PlatformThrottle {
  /** 串行队列尾部，保证同平台请求严格依次放行 */
  chain: Promise<unknown>
  /** 上一次实际放行时间 */
  lastRequestAt: number
  /** 风控冷却截止时间 */
  cooldownUntil: number
  /** 连续触发风控的次数（成功一次复位），驱动冷却时长指数退避 */
  cooldownLevel: number
}

const throttles = new Map<LX.AccountSource.Platform, PlatformThrottle>()

const getThrottle = (platform: LX.AccountSource.Platform): PlatformThrottle => {
  let throttle = throttles.get(platform)
  if (!throttle) {
    throttle = { chain: Promise.resolve(), lastRequestAt: 0, cooldownUntil: 0, cooldownLevel: 0 }
    throttles.set(platform, throttle)
  }
  return throttle
}

const getIntervalMs = (platform: LX.AccountSource.Platform) => {
  const seconds = Number(global.lx.appSetting[`accountSource.requestInterval.${platform}` as keyof LX.AppSetting]) || 0
  if (seconds <= 0) return 0
  // ±20% 抖动，避免固定节奏被识别为机器行为
  return seconds * 1000 * (0.8 + Math.random() * 0.4)
}

export const isCoolingDown = (platform: LX.AccountSource.Platform) => {
  return Date.now() < getThrottle(platform).cooldownUntil
}

const sleep = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 平台队列内执行一次解析请求：按最小间隔放行，风控触发时该平台进入指数冷却。
 * 同平台的播放/下载/开放 API 请求都经过这里串行限速。
 */
export const runThrottled = async<T>(platform: LX.AccountSource.Platform, task: () => Promise<T>): Promise<T> => {
  const throttle = getThrottle(platform)
  const run = throttle.chain.then(async() => {
    if (Date.now() < throttle.cooldownUntil) {
      throw new RiskControlError(`${platform} 账号冷却中，剩余 ${Math.ceil((throttle.cooldownUntil - Date.now()) / 60000)} 分钟`)
    }
    const wait = getIntervalMs(platform) - (Date.now() - throttle.lastRequestAt)
    if (wait > 0) await sleep(wait)
    throttle.lastRequestAt = Date.now()
    try {
      const result = await task()
      throttle.cooldownLevel = 0
      return result
    } catch (err) {
      if (err instanceof RiskControlError) {
        throttle.cooldownLevel++
        const cooldownMs = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (throttle.cooldownLevel - 1))
        throttle.cooldownUntil = Date.now() + cooldownMs
        console.log(`[account-source:${platform}] 风控冷却 ${Math.round(cooldownMs / 60000)} 分钟(连续第 ${throttle.cooldownLevel} 次)`)
      }
      throw err
    }
  })
  // 链上任一请求失败不能断队列，吞掉原因继续串后续请求
  throttle.chain = run.catch(() => {})
  return run
}
