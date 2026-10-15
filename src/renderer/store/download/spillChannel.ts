// 脚本供给源后端（ADR 0006/0007）：成员 = 内置源 + 用户导入的自定义源脚本，导入即入池、删源即出池。
// 统一名册与调度在 providerPool.ts；本模块只管脚本供给源自身的事：节流（串行 2s）、
// （成员 × 平台）升级熔断（连败 3 次 → 停 1 分钟，翻倍 1→2→4→8 分钟封顶，同平台成功归零）、
// 沙箱 init 后的能力上报。仅服务 128k（音质政策门槛在 providerPool 过滤）。
// 成员能力（平台×128k）：内置静态表 + 沙箱 init 成功后的动态上报；导入成员上报前视为全能候选。
import { getUserApiList, onPoolMemberInfo, requestAccountSpillUrl } from '@renderer/utils/ipc'

export const SPILL_API_ID = 'user_api_builtin_yehua'

const INTERVAL_MS = 2000
const BREAK_THRESHOLD = 3
const BASE_BREAK_MS = 60 * 1000
const MAX_BREAK_MS = 8 * 60 * 1000
const IMPORT_LIST_TTL_MS = 30_000

// 内置成员的 128k 平台能力与短名（实测声明 + 真机下载复核，见 plans/03 与 issues/）；徽标与状态文本用短名
const BUILTIN_MEMBERS: Record<string, { name: string, platforms: string[] }> = {
  user_api_builtin_yehua: { name: '野花', platforms: ['kw', 'kg', 'tx', 'wy', 'mg'] },
  // 野草与野花同一后端（97.64.37.235）仅路径命名空间不同，维护者权衡后保留；全豆要同日移除——均见 issues/03-remove-qdy-and-yecao
  user_api_builtin_yecao: { name: '野草', platforms: ['kw'] },
}

/** （成员 × 平台）独立的熔断计数：连败 3 次熔断，翻倍 1→2→4→8 分钟封顶，同平台成功归零 */
interface PlatformRuntime {
  failCount: number
  brokenUntil: number
  /** 连续熔断次数（期间同平台无成功）：决定本次停用时长 */
  breakStreak: number
}

interface MemberRuntime {
  chain: Promise<unknown>
  lastRequestAt: number
  inFlight: number
  /** init 上报的可服务 128k 平台；null = 未知（视为全能候选） */
  capablePlatforms: string[] | null
  platforms: Map<string, PlatformRuntime>
}

const runtimes = new Map<string, MemberRuntime>()

const runtime = (id: string): MemberRuntime => {
  let m = runtimes.get(id)
  if (!m) {
    m = { chain: Promise.resolve(), lastRequestAt: 0, inFlight: 0, capablePlatforms: null, platforms: new Map() }
    runtimes.set(id, m)
  }
  return m
}

const platformRuntime = (id: string, source: string): PlatformRuntime => {
  const m = runtime(id)
  let p = m.platforms.get(source)
  if (!p) {
    p = { failCount: 0, brokenUntil: 0, breakStreak: 0 }
    m.platforms.set(source, p)
  }
  return p
}

// 成员名册 = 全部用户源（内置 + 导入）。导入/删源后 30s 内热更新；列表拉取失败时退回内置名册
interface RosterEntry { id: string, name: string }
const BUILTIN_ROSTER: RosterEntry[] = Object.entries(BUILTIN_MEMBERS).map(([id, m]) => ({ id, name: m.name }))
let rosterCache: { at: number, members: RosterEntry[] } | null = null
const setRosterCache = (cache: { at: number, members: RosterEntry[] }) => { rosterCache = cache }
export const getRoster = async(): Promise<RosterEntry[]> => {
  const cached = rosterCache
  if (cached && Date.now() - cached.at < IMPORT_LIST_TTL_MS) return cached.members
  try {
    const list = await getUserApiList()
    const fresh = {
      at: Date.now(),
      members: list.map(a => ({ id: a.id, name: BUILTIN_MEMBERS[a.id]?.name ?? a.name })),
    }
    setRosterCache(fresh)
    return fresh.members
  } catch {
    return cached?.members ?? BUILTIN_ROSTER
  }
}

/** 成员声明的能力是否覆盖该平台；未上报（null）视为全能候选 */
export const isMemberCapable = (id: string, source: string): boolean => {
  const m = runtime(id)
  const declared = BUILTIN_MEMBERS[id]?.platforms ?? m.capablePlatforms
  if (!declared) return true
  return declared.includes(source)
}

export const isMemberBroken = (id: string, source: string): boolean => Date.now() < platformRuntime(id, source).brokenUntil

export const poolMemberInFlight = (id: string): number => runtime(id).inFlight
export const poolMemberBegin = (id: string) => { runtime(id).inFlight++ }
export const poolMemberEnd = (id: string) => { runtime(id).inFlight-- }

/** 该平台上最早恢复的熔断成员时间戳；0 = 该平台无成员在熔断 */
export const poolEarliestRecovery = (source: string): number => {
  let earliest = 0
  for (const m of runtimes.values()) {
    const p = m.platforms.get(source)
    if (p && p.brokenUntil > Date.now() && (earliest == 0 || p.brokenUntil < earliest)) earliest = p.brokenUntil
  }
  return earliest
}

const sleep = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const memberLogName = (id: string) => BUILTIN_MEMBERS[id]?.name ?? id

const recordMemberFailure = (id: string, source: string) => {
  const p = platformRuntime(id, source)
  p.failCount++
  if (p.failCount >= BREAK_THRESHOLD) {
    p.breakStreak++
    const breakMs = Math.min(BASE_BREAK_MS * 2 ** (p.breakStreak - 1), MAX_BREAK_MS)
    p.brokenUntil = Date.now() + breakMs
    p.failCount = 0
    console.log(`[pool] ${memberLogName(id)} ${source} 连败熔断，停用 ${Math.round(breakMs / 1000)} 秒（第 ${p.breakStreak} 次）`)
  }
}

const recordMemberSuccess = (id: string, source: string) => {
  const p = platformRuntime(id, source)
  p.failCount = 0
  p.breakStreak = 0
}

export const resolveViaPoolMember = async(member: { id: string, name: string }, source: LX.AccountSource.Platform, type: LX.Quality, musicInfo: Record<string, any>): Promise<string> => {
  const m = runtime(member.id)
  if (isMemberBroken(member.id, source)) throw new Error('三方通道成员熔断中')
  const run = m.chain.then(async() => {
    if (isMemberBroken(member.id, source)) throw new Error('三方通道成员熔断中')
    const wait = INTERVAL_MS - (Date.now() - m.lastRequestAt)
    if (wait > 0) await sleep(wait)
    m.lastRequestAt = Date.now()
    try {
      const { url } = await requestAccountSpillUrl({ source, type, musicInfo, memberId: member.id })
      recordMemberSuccess(member.id, source)
      return url
    } catch (err) {
      recordMemberFailure(member.id, source)
      throw err
    }
  })
  // 链上任一失败不断队列
  m.chain = run.catch(() => {})
  return run
}

/**
 * 下载层成败回灌（issue source-pool/01）：解析成功 ≠ 直链可用（模板源只拼 URL 不验证），
 * 下载阶段的 404/断流等失败按（成员 × 平台）记账走同一套升级熔断，成功则归零。
 */
export const poolMemberReportDownload = (memberId: string, source: string, ok: boolean) => {
  if (ok) {
    recordMemberSuccess(memberId, source)
    return
  }
  recordMemberFailure(memberId, source)
  console.log(`[pool] ${memberLogName(memberId)} ${source} 下载失败计 1 次（failCount=${platformRuntime(memberId, source).failCount}/${BREAK_THRESHOLD}）`)
}

// 沙箱 init 成功后的能力上报：记录成员可服务 128k 的平台，后续选择据此过滤
onPoolMemberInfo(({ params: { id, sources } }) => {
  const platforms = Object.entries(sources ?? {})
    .filter(([, info]) => info.actions?.includes('musicUrl') && info.qualitys?.includes('128k'))
    .map(([platform]) => platform)
  runtime(id).capablePlatforms = platforms
  console.log(`[pool] 成员能力上报 ${BUILTIN_MEMBERS[id]?.name ?? id}:`, platforms.join('/') || '无')
})
