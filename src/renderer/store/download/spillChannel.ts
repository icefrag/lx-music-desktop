// 三方通道（内置野花，ADR 0005）：下载链路专用解析路径。
// 渲染层独立节流（串行 2s，与账号队列节奏互不干扰）+ 熔断（连续失败 3 次停用 5 分钟）。
import { requestAccountSpillUrl } from '@renderer/utils/ipc'

export const SPILL_API_ID = 'user_api_builtin_yehua'

const INTERVAL_MS = 2000
const BREAK_THRESHOLD = 3
const BREAK_MS = 5 * 60 * 1000

let chain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0
let failCount = 0
let brokenUntil = 0

export const isSpillBroken = (): boolean => Date.now() < brokenUntil
export const spillBrokenUntil = (): number => brokenUntil

const sleep = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const resolveViaSpill = async(source: LX.AccountSource.Platform, type: LX.Quality, musicInfo: Record<string, any>): Promise<string> => {
  if (isSpillBroken()) throw new Error('三方通道熔断中')
  const run = chain.then(async() => {
    if (isSpillBroken()) throw new Error('三方通道熔断中')
    const wait = INTERVAL_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    try {
      const { url } = await requestAccountSpillUrl({ source, type, musicInfo })
      failCount = 0
      return url
    } catch (err) {
      failCount++
      if (failCount >= BREAK_THRESHOLD) {
        brokenUntil = Date.now() + BREAK_MS
        failCount = 0
        console.log('[spill] 连续失败，熔断 5 分钟')
      }
      throw err
    }
  })
  // 链上任一失败不断队列
  chain = run.catch(() => {})
  return run
}
