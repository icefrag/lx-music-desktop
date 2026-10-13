import crypto from 'node:crypto'
import { httpFetch } from '@main/utils/request'
import { BROWSER_UA, getCookieHeader, getCookieMap } from '../sessions'
import { AuthExpiredError } from '../errors'

// 酷狗移动端通道（v5/url）签名参数，复刻自开源项目 MakcRe/KuGouMusicApi
const ANDROID_SIGN_SALT = 'OIlwieks28dk2k092lksi2UIkp'
const SKEY_SALT = '57ae12eb6890223e355ccfcb74edf70d'
const KG_APPID = 1005
const KG_CLIENTVER = 20489
// v5/url 通道自带的版本与埋点标识（区别于 usercenter 的 KG_CLIENTVER）
const KG_URL_CLIENTVER = 11430
const KG_VERSION = 11430
const KG_PAGE_ID = 151369488
const KG_PPAGE_ID = '463467626,350369493,788954147'
const KG_PIDVERSION = 3001
const CLIENT_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

// 网页端通道（play/songinfo）参数：与网页登录凭证的平台一致（token 与 appid 平台不符会报 error_code 20018）
const WEB_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const WEB_APPID = 1014
const WEB_CLIENTVER = 20000
const WEB_PLATID = 4
const WEB_SRCAPPID = 2919
// eslint-disable-next-line max-len
const KG_RSA_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n-----END PUBLIC KEY-----'

const md5 = (text: string) => crypto.createHash('md5').update(text, 'utf8').digest('hex')

// calculateMid：md5 hex 转 128 位十进制大整数
const calcMid = (str: string) => BigInt(`0x${md5(str)}`).toString()

const randomString = (len: number) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: len }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('')
}

// Android 版签名：盐 + 按 key 排序的 key=value 串 + 请求体 + 盐
const signatureAndroid = (params: Record<string, string | number>, data = '') => {
  const paramsString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('')
  return md5(`${ANDROID_SIGN_SALT}${paramsString}${data}${ANDROID_SIGN_SALT}`)
}

// Web 版签名：盐 + 排序后的 key=value 串 + 盐
const signatureWeb = (params: Record<string, string | number>) => {
  const paramsString = Object.keys(params)
    .map(key => `${key}=${params[key]}`)
    .sort()
    .join('')
  return md5(`${WEB_SIGN_SALT}${paramsString}${WEB_SIGN_SALT}`)
}

// key = md5(hash + 盐 + appid + mid + userid)
const signKey = (hash: string, mid: string, userid: string | number) => {
  return md5(`${hash}${SKEY_SALT}${KG_APPID}${mid}${userid || 0}`)
}

// usercenter get_my_info 的 p 参数：零填充裸 RSA（NO_PADDING），大写 hex
const rsaEncryptRaw = (data: string) => {
  const buffer = Buffer.from(data, 'utf8')
  if (buffer.length > 128) throw new Error(`酷狗凭证加密数据超长(${buffer.length} > 128)`)
  const padded = Buffer.alloc(128)
  buffer.copy(padded, 0)
  return crypto.publicEncrypt({ key: KG_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex').toUpperCase()
}

interface KgCredential {
  token: string
  userid: string
  mid: string
  dfid: string
}

// KuGoo 复合 cookie 是 & 分隔的 k=v 串（可能整体做过一次 URL 编码），网页端登录态字段全在里面
const parseKuGooCookie = (value?: string) => {
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

const getCredential = async(): Promise<KgCredential> => {
  // 网页登录后 .kugou.com 域实际写入：KuGoo（复合 cookie，内含 t=登录令牌、KugooID=用户 id）、kg_mid（设备 mid）、kg_dfid（设备指纹）
  const cookies = await getCookieMap('kg')
  const kuGoo = parseKuGooCookie(cookies.KuGoo)
  const token = kuGoo.t ?? cookies.t ?? ''
  const userid = kuGoo.KugooID ?? cookies.KugooID ?? '0'
  const mid = cookies.kg_mid ?? calcMid(`lx-account-source-kg:${userid}`)
  const dfid = cookies.kg_dfid ?? cookies.dfid ?? randomString(24)
  return { token, userid, mid, dfid }
}

interface KgResponse {
  status?: number
  errcode?: number | string
  error_code?: number
  errmsg?: string
  error_msg?: string
}

const kgRequest = async<T extends KgResponse>(url: string, params: Record<string, string | number>, {
  method = 'GET',
  router,
  data,
}: {
  method?: 'GET' | 'POST'
  router?: string
  data?: Record<string, unknown>
} = {}) => {
  const dataString = data ? JSON.stringify(data) : ''
  const signature = signatureAndroid(params, dataString)
  const { body, statusCode } = await httpFetch<T>(`https://gateway.kugou.com${url}`, {
    method,
    query: { ...params, signature },
    json: method == 'POST' ? data : undefined,
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      'User-Agent': CLIENT_UA,
      dfid: String(params.dfid),
      clienttime: String(params.clienttime),
      mid: String(params.mid),
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      ...(router ? { 'x-router': router } : {}),
    },
  })
  if (statusCode != 200) throw new Error(`酷狗音乐接口请求失败(${statusCode})`)
  return body
}

// 网页端取链通道：play/songinfo，返回当前账号权限下的最佳可用音质直链
interface WebSongInfo extends KgResponse {
  data?: { play_url?: string, bitrate?: number, timelen?: number, privilage?: number, encode_album_audio_id?: string }
}

const webSonginfoRequest = async(songParams: Record<string, string | number>) => {
  const { token, userid, mid, dfid } = await getCredential()
  const params: Record<string, string | number> = {
    srcappid: WEB_SRCAPPID,
    appid: WEB_APPID,
    clientver: WEB_CLIENTVER,
    // 浏览器端 clienttime 是毫秒级
    clienttime: Date.now(),
    mid,
    // 浏览器端 uuid 参数就是 mid 的值
    uuid: mid,
    dfid,
    platid: WEB_PLATID,
    // token 需与 userid 成对提交，酷狗才按登录账号判定版权权限
    token,
    ...(userid && userid != '0' ? { userid } : {}),
    ...songParams,
  }
  const { body, statusCode } = await httpFetch<WebSongInfo>('https://wwwapi.kugou.com/play/songinfo', {
    method: 'GET',
    query: { ...params, signature: signatureWeb(params) },
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      'User-Agent': BROWSER_UA,
      Cookie: await getCookieHeader('kg'),
      Referer: 'https://www.kugou.com/',
    },
  })
  if (statusCode != 200) throw new Error(`酷狗音乐接口请求失败(${statusCode})`)
  return body
}

// 音质从高到低的降级链，目标：能下到歌最重要，音质有什么用什么
const QUALITY_VALUES: Partial<Record<LX.Quality, string[]>> = {
  flac24bit: ['high', 'flac', '320', '128'],
  flac: ['flac', '320', '128'],
  '320k': ['320', '128'],
  '128k': ['128'],
}

// v5/url 响应里 url 字段存在多种结构（字符串/对象/数组），逐层取第一个直链
const pickUrl = (body: unknown): string | undefined => {
  const record = body as Record<string, unknown>
  const candidates: unknown[] = []
  for (const key of ['url', 'backupUrl', 'urls', 'data']) {
    const value = record?.[key]
    if (Array.isArray(value)) candidates.push(...value)
    else if (value != null) candidates.push(value)
  }
  for (const candidate of candidates) {
    if (typeof candidate == 'string' && candidate.startsWith('http')) return candidate
    const obj = candidate as Record<string, unknown> | null
    const first = obj?.url ?? (Array.isArray(obj?.urls) ? (obj?.urls as unknown[])[0] : undefined)
    if (typeof first == 'string' && first.startsWith('http')) return first
  }
  return undefined
}

interface UserInfoData extends KgResponse {
  data?: { nickname?: string, username?: string }
}

export const validate = async() => {
  const { token, userid, mid, dfid } = await getCredential()
  if (!token) throw new Error('未获取到酷狗登录凭证（token），请确认登录成功')
  const clienttime = Date.now()
  const body = await kgRequest<UserInfoData>('/v3/get_my_info', {
    dfid,
    mid,
    uuid: '-',
    appid: KG_APPID,
    clientver: KG_CLIENTVER,
    clienttime: Math.floor(clienttime / 1000),
    plat: 1,
    userid,
  }, {
    method: 'POST',
    router: 'usercenter.kugou.com',
    data: {
      visit_time: clienttime,
      usertype: 1,
      p: rsaEncryptRaw(JSON.stringify({ token, clienttime })),
      userid: Number(userid) || 0,
    },
  })
  if (body.status == 1) return { ok: true, nickname: body.data?.nickname ?? body.data?.username }
  throw new Error(`酷狗音乐凭证校验未通过(${body.errcode ?? body.error_code ?? body.status})`)
}

export const getMusicUrl = async(songInfo: Record<string, any>, quality: LX.Quality) => {
  const hash = String(songInfo.hash ?? songInfo.songmid ?? '').toLowerCase()
  if (!hash) throw new Error('缺少酷狗音乐歌曲HASH')
  const { token, userid, mid, dfid } = await getCredential()
  if (!token) throw new AuthExpiredError('未获取到酷狗登录凭证（token），请重新登录')

  // 首选网页端通道：与网页登录凭证平台一致；服务端按账号权限返回最佳音质
  const webBody = await webSonginfoRequest({
    album_id: Number(songInfo.albumId) || 0,
    album_audio_id: Number(songInfo.albumAudioId) || 0,
    hash,
  })
  if (webBody.data?.play_url) return webBody.data.play_url

  // hash 形态无直链时，改用浏览器形态重试：网页播放器只用 encode_album_audio_id 定位歌曲（第一步响应里会回传该值）
  const encodeId = webBody.data?.encode_album_audio_id
  if (encodeId) {
    const webBody2 = await webSonginfoRequest({ encode_album_audio_id: encodeId })
    if (webBody2.data?.play_url) return webBody2.data.play_url
  }
  if (webBody.status == 0 && (webBody.error_code == 301 || webBody.errcode == 301)) {
    throw new AuthExpiredError('酷狗音乐登录凭证已失效')
  }

  // 兜底：移动端 v5/url 通道（网页 token 与其 appid 平台不符时会报 20018，仅在网页通道无果时尝试）
  for (const qualityValue of QUALITY_VALUES[quality] ?? ['128']) {
    const params: Record<string, string | number> = {
      dfid,
      mid,
      uuid: '-',
      appid: KG_APPID,
      clientver: KG_URL_CLIENTVER,
      clienttime: Math.floor(Date.now() / 1000),
      album_id: Number(songInfo.albumId) || 0,
      area_code: 1,
      hash,
      ssa_flag: 'is_fromtrack',
      version: KG_VERSION,
      page_id: KG_PAGE_ID,
      quality: qualityValue,
      album_audio_id: Number(songInfo.albumAudioId) || 0,
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: KG_PIDVERSION,
      IsFreePart: 0,
      ppage_id: KG_PPAGE_ID,
      cdnBackup: 1,
      module: '',
    }
    if (token) params.token = token
    if (userid && userid != '0') params.userid = userid
    params.key = signKey(hash, mid, userid)
    const body = await kgRequest<KgResponse & Record<string, unknown>>('/v5/url', params, {
      router: 'trackercdn.kugou.com',
    })
    // 诊断日志：真机验证期观察酷狗真实响应，稳定后移除
    console.log(`[account-source:kg] ${qualityValue} ${hash} ->`, JSON.stringify(body).slice(0, 400))
    if (body.errcode == 20028 || body.error_code == 20028) {
      throw new Error('酷狗音乐触发安全验证，请稍后重试或重新登录')
    }
    if (token && (body.errcode == 20001 || body.error_code == 30202)) {
      throw new AuthExpiredError('酷狗音乐登录凭证已失效')
    }
    const url = pickUrl(body)
    if (url) return url
  }
  throw new Error('酷狗音乐未返回可用音源')
}
