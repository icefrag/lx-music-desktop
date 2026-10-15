// 统一供给池（ADR 0007）：账号供给源（kg/tx/wy 会员凭据实例）与脚本供给源（音源池成员）同一名册，
// 分发器单循环调度：能力（平台×音质）过滤 → 健康过滤 → 在途最少者优先，纯看空闲不看身份
// （0005「同时可用优先账号」tie-break 翻案废除，平局按名册序落在脚本供给源）。
// 健康双通道保持分离：账号 = 风控冷却（平台强加、立即生效的外部信号，不记连败）；
// 脚本 = （成员×平台）升级熔断（自计数，见 spillChannel）。音质政策门槛：脚本仅 128k。
import { getMusicUrl } from '@renderer/core/music/online'
import { toOldMusicInfo } from '@renderer/utils'
import { accountSource } from '..'
import {
  getRoster,
  isMemberBroken,
  isMemberCapable,
  poolEarliestRecovery,
  poolMemberBegin,
  poolMemberEnd,
  poolMemberInFlight,
  resolveViaPoolMember,
} from './spillChannel'

export interface PoolProvider {
  /** 账号供给源：`account:<platform>`；脚本供给源：userApi id（兜底链跳过判断依赖原样 id） */
  id: string
  name: string
  kind: 'account' | 'script'
  platform: string
}

// 账号音源生效的平台（凭证登录且未过期）；解析由主进程账号队列串行限速保护，渲染层只记在途
export const isAccountSourceActive = (source: string): boolean => {
  if (source != 'kg' && source != 'tx' && source != 'wy') return false
  const status = accountSource.status[source]
  return status?.login && status.status != 'expired'
}

export const isPlatformCoolingDown = (source: string): boolean => {
  return Date.now() < (accountSource.status[source as LX.AccountSource.Platform]?.cooldownUntil ?? 0)
}

// 跨并发分发共享的账号在途计数（一平台一凭据实例，按平台记账）
const accountInFlightByPlatform = new Map<string, number>()
const accountInFlight = (source: string): number => accountInFlightByPlatform.get(source) ?? 0

/** 是否存在可服务（平台×音质）的供给源（只看能力不看健康；全恢复期也视为有资格，走等待路径） */
export const isDispatchEligible = async(source: string, quality: LX.Quality): Promise<boolean> => {
  if (quality == '128k') {
    for (const member of await getRoster()) {
      if (isMemberCapable(member.id, source)) return true
    }
  }
  return isAccountSourceActive(source)
}

/** 选一个可服务（平台×音质）的空闲健康供给源；无候选返回 null */
export const pickProvider = async(source: string, quality: LX.Quality, excludeIds: string[] = []): Promise<PoolProvider | null> => {
  let best: PoolProvider | null = null
  let bestInFlight = Number.MAX_SAFE_INTEGER
  const consider = (provider: PoolProvider, inFlight: number) => {
    if (inFlight < bestInFlight) {
      best = provider
      bestInFlight = inFlight
    }
  }
  if (quality == '128k') {
    for (const member of await getRoster()) {
      if (excludeIds.includes(member.id)) continue
      if (isMemberBroken(member.id, source)) continue
      if (!isMemberCapable(member.id, source)) continue
      consider({ id: member.id, name: member.name, kind: 'script', platform: source }, poolMemberInFlight(member.id))
    }
  }
  if (isAccountSourceActive(source) && !isPlatformCoolingDown(source) && !excludeIds.includes(`account:${source}`)) {
    consider({ id: `account:${source}`, name: '账号', kind: 'account', platform: source }, accountInFlight(source))
  }
  return best
}

/** 经供给源解析下载直链，失败抛错。账号在途/脚本在途的记账都在此收口。
 * isRefresh：换链（refreshUrl）必须穿透 musicSdk 的 URL 缓存取新链接，否则死链缓存会让换链空转 */
export const resolveViaProvider = async(provider: PoolProvider, musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality, isRefresh: boolean = false): Promise<string> => {
  if (provider.kind == 'account') {
    accountInFlightByPlatform.set(provider.platform, accountInFlight(provider.platform) + 1)
    try {
      // 账号链路（musicSdk 账号 API）：内含「账号失败落生效音源」的内联兜底（0005 延续）；
      // noRiskControlFallback：风控冷却抛错回分发器转移，不静默降级
      return await getMusicUrl({ musicInfo, isRefresh, quality, allowToggleSource: false, noRiskControlFallback: true })
    } finally {
      accountInFlightByPlatform.set(provider.platform, accountInFlight(provider.platform) - 1)
    }
  }
  poolMemberBegin(provider.id)
  try {
    return await resolveViaPoolMember(provider, provider.platform as LX.AccountSource.Platform, quality, toOldMusicInfo(musicInfo))
  } finally {
    poolMemberEnd(provider.id)
  }
}

/** 该平台（限定音质可服务的供给源中）最早恢复时间戳；0 = 无供给源在恢复期 */
export const earliestRecovery = (source: string, quality: LX.Quality): number => {
  let earliest = 0
  const consider = (at: number) => {
    if (at > Date.now() && (earliest == 0 || at < earliest)) earliest = at
  }
  if (quality == '128k') consider(poolEarliestRecovery(source))
  if (isAccountSourceActive(source)) consider(accountSource.status[source as LX.AccountSource.Platform]?.cooldownUntil ?? 0)
  return earliest
}
