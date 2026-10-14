// 三方通道池（ADR 0006）：成员 = 内置源 + 用户导入的自定义源脚本，导入即入池、删源即出池。
// 每成员独立节流（串行 2s）与升级熔断：连败 3 次 → 停 5 分钟，反复熔断时长指数升级（5→10→…封顶 60 分钟），任一次成功归零。
// 成员能力（平台×128k）：内置静态表 + 沙箱 init 成功后的动态上报；导入成员上报前视为全能候选。
import { getUserApiList, onPoolMemberInfo, requestAccountSpillUrl } from '@renderer/utils/ipc'

export const SPILL_API_ID = 'user_api_builtin_yehua'

const INTERVAL_MS = 2000
const BREAK_THRESHOLD = 3
const BASE_BREAK_MS = 5 * 60 * 1000
const MAX_BREAK_MS = 60 * 60 * 1000
const IMPORT_LIST_TTL_MS = 30_000

// 内置成员的 128k 平台能力与短名（实测声明，见 plans/03）；徽标与状态文本用短名
const BUILTIN_MEMBERS: Record<string, { name: string, platforms: string[] }> = {
  user_api_builtin_yehua: { name: '野花', platforms: ['kw', 'kg', 'tx', 'wy', 'mg'] },
  user_api_builtin_yecao: { name: '野草', platforms: ['kw'] },
  user_api_builtin_changqing: { name: '长青', platforms: ['kw', 'kg', 'tx', 'wy', 'mg'] },
  user_api_builtin_huanyin: { name: '幻音', platforms: ['kw', 'tx', 'wy', 'mg'] },
  user_api_builtin_qdy: { name: '全豆要', platforms: ['kw', 'kg', 'tx', 'wy', 'mg'] },
}

interface MemberRuntime {
  chain: Promise<unknown>
  lastRequestAt: number
  failCount: number
  brokenUntil: number
  /** 连续熔断次数（期间无成功）：决定本次停用时长，成功归零 */
  breakStreak: number
  inFlight: number
  /** init 上报的可服务 128k 平台；null = 未知（视为全能候选） */
  capablePlatforms: string[] | null
}

const runtimes = new Map<string, MemberRuntime>()

const runtime = (id: string): MemberRuntime => {
  let m = runtimes.get(id)
  if (!m) {
    m = { chain: Promise.resolve(), lastRequestAt: 0, failCount: 0, brokenUntil: 0, breakStreak: 0, inFlight: 0, capablePlatforms: null }
    runtimes.set(id, m)
  }
  return m
}

// 成员名册 = 全部用户源（内置 + 导入）。导入/删源后 30s 内热更新；列表拉取失败时退回内置名册
interface RosterEntry { id: string, name: string }
const BUILTIN_ROSTER: RosterEntry[] = Object.entries(BUILTIN_MEMBERS).map(([id, m]) => ({ id, name: m.name }))
let rosterCache: { at: number, members: RosterEntry[] } | null = null
const setRosterCache = (cache: { at: number, members: RosterEntry[] }) => { rosterCache = cache }
const getRoster = async(): Promise<RosterEntry[]> => {
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

const isMemberCapable = (id: string, source: string): boolean => {
  const m = runtime(id)
  const declared = BUILTIN_MEMBERS[id]?.platforms ?? m.capablePlatforms
  if (!declared) return true
  return declared.includes(source)
}

export const isMemberBroken = (id: string): boolean => Date.now() < runtime(id).brokenUntil

/** 选一个可服务 (source × 128k) 的健康成员：非熔断、非排除、能力匹配，在途最少者优先（平局按名册序） */
export const poolPickMember = async(source: string, excludeIds: string[] = []): Promise<{ id: string, name: string } | null> => {
  const roster = await getRoster()
  let best: { id: string, name: string } | null = null
  let bestInFlight = Number.MAX_SAFE_INTEGER
  for (const member of roster) {
    if (excludeIds.includes(member.id)) continue
    if (isMemberBroken(member.id)) continue
    if (!isMemberCapable(member.id, source)) continue
    const inFlight = runtime(member.id).inFlight
    if (inFlight < bestInFlight) {
      best = member
      bestInFlight = inFlight
    }
  }
  return best
}

export const poolMemberInFlight = (id: string): number => runtime(id).inFlight
export const poolMemberBegin = (id: string) => { runtime(id).inFlight++ }
export const poolMemberEnd = (id: string) => { runtime(id).inFlight-- }

/** 全池最早恢复时间戳；0 = 无成员在熔断 */
export const poolEarliestRecovery = (): number => {
  let earliest = 0
  for (const m of runtimes.values()) {
    if (m.brokenUntil > Date.now() && (earliest == 0 || m.brokenUntil < earliest)) earliest = m.brokenUntil
  }
  return earliest
}

const sleep = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const resolveViaPoolMember = async(member: { id: string, name: string }, source: LX.AccountSource.Platform, type: LX.Quality, musicInfo: Record<string, any>): Promise<string> => {
  const m = runtime(member.id)
  if (isMemberBroken(member.id)) throw new Error('三方通道成员熔断中')
  const run = m.chain.then(async() => {
    if (isMemberBroken(member.id)) throw new Error('三方通道成员熔断中')
    const wait = INTERVAL_MS - (Date.now() - m.lastRequestAt)
    if (wait > 0) await sleep(wait)
    m.lastRequestAt = Date.now()
    try {
      const { url } = await requestAccountSpillUrl({ source, type, musicInfo, memberId: member.id })
      m.failCount = 0
      m.breakStreak = 0
      return url
    } catch (err) {
      m.failCount++
      if (m.failCount >= BREAK_THRESHOLD) {
        m.breakStreak++
        const breakMs = Math.min(BASE_BREAK_MS * 2 ** (m.breakStreak - 1), MAX_BREAK_MS)
        m.brokenUntil = Date.now() + breakMs
        m.failCount = 0
        console.log(`[pool] ${member.name} 连败熔断，停用 ${Math.round(breakMs / 60000)} 分钟（第 ${m.breakStreak} 次）`)
      }
      throw err
    }
  })
  // 链上任一失败不断队列
  m.chain = run.catch(() => {})
  return run
}

// 沙箱 init 成功后的能力上报：记录成员可服务 128k 的平台，后续选择据此过滤
onPoolMemberInfo(({ params: { id, sources } }) => {
  const platforms = Object.entries(sources ?? {})
    .filter(([, info]) => info.actions?.includes('musicUrl') && info.qualitys?.includes('128k'))
    .map(([platform]) => platform)
  runtime(id).capablePlatforms = platforms
  console.log(`[pool] 成员能力上报 ${BUILTIN_MEMBERS[id]?.name ?? id}:`, platforms.join('/') || '无')
})
