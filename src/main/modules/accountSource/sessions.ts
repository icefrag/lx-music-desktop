import { session } from 'electron'
import { PARTITION_NAMES, PLATFORM_CONFIGS } from './const'

// 登录窗口会加载平台登录页，UA 不能带 Electron 标识，否则容易被平台差异化对待
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export { BROWSER_UA }

const configuredPartitions = new Set<string>()

const getSession = (platform: LX.AccountSource.Platform) => {
  const ses = session.fromPartition(PARTITION_NAMES[platform])
  if (!configuredPartitions.has(platform)) {
    configuredPartitions.add(platform)
    ses.setUserAgent(BROWSER_UA)
  }
  return ses
}

const matchDomain = (host: string, domains: string[]) => {
  const host2 = host.startsWith('.') ? host.slice(1) : host
  return domains.some(domain => host2 == domain || host2.endsWith(`.${domain}`))
}

const matchCookie = (config: typeof PLATFORM_CONFIGS[LX.AccountSource.Platform], cookie: { name: string, domain?: string, value: string }) => {
  return config.loginCookieKeys.includes(cookie.name) &&
    matchDomain(cookie.domain ?? '', config.cookieDomains) &&
    (config.checkLoginCookieValue == null || config.checkLoginCookieValue(cookie))
}

export const getLoginCookie = async(platform: LX.AccountSource.Platform) => {
  const config = PLATFORM_CONFIGS[platform]
  const cookies = await getSession(platform).cookies.get({})
  return cookies.find(cookie => matchCookie(config, cookie))
}

export const hasLoginCookie = async(platform: LX.AccountSource.Platform) => {
  return (await getLoginCookie(platform)) != null
}

/** 分区内平台域的 cookie 键值对（重名以后写的为准） */
export const getCookieMap = async(platform: LX.AccountSource.Platform) => {
  const config = PLATFORM_CONFIGS[platform]
  const cookies = (await getSession(platform).cookies.get({}))
    .filter(cookie => matchDomain(cookie.domain ?? '', config.cookieDomains))
  const map: Record<string, string> = {}
  for (const cookie of cookies) map[cookie.name] = cookie.value
  return map
}

/** 把分区内的 cookie 拼成 Cookie 请求头 */
export const getCookieHeader = async(platform: LX.AccountSource.Platform) => {
  const map = await getCookieMap(platform)
  return Object.entries(map).map(([name, value]) => `${name}=${value}`).join('; ')
}

export const clearSession = async(platform: LX.AccountSource.Platform) => {
  await getSession(platform).clearStorageData()
}

export const watchLoginCookie = (
  platform: LX.AccountSource.Platform,
  onCaptured: (cookieName: string) => void,
): (() => void) => {
  const config = PLATFORM_CONFIGS[platform]
  const ses = getSession(platform)
  let captured = false
  const handler = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
    if (removed || captured) return
    if (!matchCookie(config, cookie)) return
    captured = true
    onCaptured(cookie.name)
  }
  ses.cookies.on('changed', handler)
  return () => {
    ses.cookies.removeListener('changed', handler)
  }
}

export { getSession }
