export const ACCOUNT_SOURCE_PLATFORMS = ['kg', 'tx', 'wy'] as const

export interface AccountSourcePlatformConfig {
  id: LX.AccountSource.Platform
  name: string
  loginUrl: string
  /** 命中其一即视为登录成功的 cookie 名 */
  loginCookieKeys: string[]
  /** 参与 cookie 捕获/读取判断的域后缀 */
  cookieDomains: string[]
  /** 可选的 cookie 值校验：过滤同名但未登录态的 cookie（如酷狗的匿名 KuGoo） */
  checkLoginCookieValue?: (cookie: { name: string, value: string }) => boolean
}

/** KuGoo 复合 cookie 是 & 分隔的 k=v 串（可能整体做过一次 URL 编码），登录态字段全在里面 */
export const parseKuGooCookie = (value?: string): Record<string, string> => {
  const map: Record<string, string> = {}
  if (!value) return map
  let raw = value
  if (!raw.includes('&')) {
    try {
      const decoded = decodeURIComponent(raw)
      if (decoded.includes('&')) raw = decoded
    } catch { /* 保持原值 */ }
  }
  for (const pair of raw.split('&')) {
    const index = pair.indexOf('=')
    if (index < 1) continue
    try {
      map[decodeURIComponent(pair.slice(0, index))] = decodeURIComponent(pair.slice(index + 1))
    } catch { /* 容忍不规范编码 */ }
  }
  return map
}

export const PLATFORM_CONFIGS: Record<LX.AccountSource.Platform, AccountSourcePlatformConfig> = {
  wy: {
    id: 'wy',
    name: '网易音乐',
    loginUrl: 'https://music.163.com/#/login',
    loginCookieKeys: ['MUSIC_U'],
    cookieDomains: ['music.163.com', '163.com'],
  },
  tx: {
    id: 'tx',
    name: 'QQ音乐',
    loginUrl: 'https://y.qq.com/',
    loginCookieKeys: ['qm_keyst'],
    cookieDomains: ['y.qq.com', 'qq.com'],
  },
  kg: {
    id: 'kg',
    name: '酷狗音乐',
    loginUrl: 'https://www.kugou.com/',
    // 登录态实际写在复合 cookie KuGoo（内含 t=登录令牌、KugooID=用户 id）；
    // 独立的 t/KugooID cookie 只在部分登录方式下才写，不能作为唯一信号
    loginCookieKeys: ['KuGoo', 't', 'KugooID'],
    cookieDomains: ['kugou.com'],
    // 匿名访客也会有 KuGoo（无 t/KugooID），需校验值确认真的登录了
    checkLoginCookieValue: ({ name, value }) => {
      if (name != 'KuGoo') return true
      const map = parseKuGooCookie(value)
      return !!map.t && !!map.KugooID && map.KugooID != '0'
    },
  },
}

/** 各平台登录态隔离用的持久 session 分区 */
export const PARTITION_NAMES: Record<LX.AccountSource.Platform, string> = {
  wy: 'persist:account_source_wy',
  tx: 'persist:account_source_tx',
  kg: 'persist:account_source_kg',
}
