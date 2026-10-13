export const ACCOUNT_SOURCE_PLATFORMS = ['kg', 'tx', 'wy'] as const

export interface AccountSourcePlatformConfig {
  id: LX.AccountSource.Platform
  name: string
  loginUrl: string
  /** 命中其一即视为登录成功的 cookie 名 */
  loginCookieKeys: string[]
  /** 参与 cookie 捕获/读取判断的域后缀 */
  cookieDomains: string[]
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
    // 网页登录后写入 .kugou.com 的凭证：t（登录令牌）、KugooID（用户 id）、UserName
    loginCookieKeys: ['t', 'KugooID'],
    cookieDomains: ['kugou.com'],
  },
}

/** 各平台登录态隔离用的持久 session 分区 */
export const PARTITION_NAMES: Record<LX.AccountSource.Platform, string> = {
  wy: 'persist:account_source_wy',
  tx: 'persist:account_source_tx',
  kg: 'persist:account_source_kg',
}
