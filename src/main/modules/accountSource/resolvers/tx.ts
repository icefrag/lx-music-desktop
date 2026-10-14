import crypto from 'node:crypto'
import { httpFetch } from '@main/utils/request'
import { getCookieHeader } from '../sessions'
import { AuthExpiredError, NoSourceError, RiskControlError } from '../errors'

const QUALITY_FILE_PREFIXES: Partial<Record<LX.Quality, Array<{ prefix: string, ext: string }>>> = {
  flac24bit: [
    { prefix: 'RS02', ext: 'flac' },
    { prefix: 'FL0', ext: 'flac' },
    { prefix: 'F000', ext: 'flac' },
    { prefix: 'M800', ext: 'mp3' },
    { prefix: 'M500', ext: 'mp3' },
  ],
  flac: [
    { prefix: 'F000', ext: 'flac' },
    { prefix: 'M800', ext: 'mp3' },
    { prefix: 'M500', ext: 'mp3' },
  ],
  '320k': [
    { prefix: 'M800', ext: 'mp3' },
    { prefix: 'M500', ext: 'mp3' },
  ],
  '128k': [
    { prefix: 'M500', ext: 'mp3' },
  ],
}

const buildGuid = () => {
  let guid = ''
  for (let i = 0; i < 10; i++) guid += Math.floor(Math.random() * 10)
  return guid
}

const parseUin = (cookie: string) => {
  return /(?:^|;\s*)uin=(o?(\d+))/.exec(cookie)?.[2] ?? ''
}

const parseCookieValue = (cookie: string, name: string) => {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie)?.[1] ?? ''
}

// zzc 请求签名：SHA1 摘要按固定下标重排 + 与扰码表异或后 base64（对照 QQ 客户端算法，参考 L-1124/QQMusicApi）
const zzcSign = (payload: string) => {
  const hash = crypto.createHash('sha1').update(payload).digest('hex').toUpperCase()
  const part1 = [23, 14, 6, 36, 16, 7, 19].map(i => hash[i]).join('')
  const part2 = [16, 1, 32, 12, 19, 27, 8, 5].map(i => hash[i]).join('')
  const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]
  const mixed = Buffer.alloc(scramble.length)
  scramble.forEach((value, i) => {
    mixed[i] = value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16)
  })
  const b64part = mixed.toString('base64').replace(/[^a-zA-Z0-9]/g, '')
  return `zzc${part1}${b64part}${part2}`.toLowerCase()
}

interface VkeyResponse {
  code?: number
  req_0?: {
    code?: number
    subcode?: number
    // data 按模块形态不同：vkey 返回 midurlinfo/msg，歌曲详情返回 track_info
    data?: {
      code?: number
      msg?: string
      midurlinfo?: Array<{ purl?: string, vkey?: string, filename?: string }>
      track_info?: { file?: { media_mid?: string } }
    }
  }
}

// 签名通道失败时的错误：500003 = 风控拒绝（req_0 无 data 字段）
const mapVkeyError = (resBody: VkeyResponse): Error => {
  if (resBody.req_0?.code == 500003) return new RiskControlError('QQ音乐触发风控，请稍后重试')
  return new Error(`QQ音乐接口返回异常(code=${resBody.req_0?.code ?? resBody.code ?? '-'})`)
}

const signedRequest = async(payload: Record<string, unknown>, keyst: string, loginType: string): Promise<VkeyResponse> => {
  // 签名必须与实际发送的 JSON 字节一致（httpFetch 内部同为 JSON.stringify）
  const body = JSON.stringify(payload)
  const { body: resBody, statusCode } = await httpFetch<VkeyResponse>('https://u.y.qq.com/cgi-bin/musics.fcg', {
    method: 'POST',
    query: { _: Date.now(), sign: zzcSign(body) },
    json: payload,
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      Cookie: await getCookieHeader('tx'),
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  })
  if (statusCode != 200) throw new Error(`QQ音乐接口请求失败(${statusCode})`)
  if (resBody?.code != 0) throw new Error(`QQ音乐接口返回异常(code=${resBody?.code})`)
  return resBody
}

// 签名通道：POST musics.fcg + zzc 签名 + music.vkey.GetVkey/UrlGetVkey（旧明文通道被风控大面积拒绝后迁移）
const vkeyViaSigned = async(songmid: string, filenames: string[], uin: string, keyst: string, loginType: string): Promise<Array<{ purl?: string }>> => {
  const payload = {
    comm: { ct: '24', cv: '0', uin, format: 'json', authst: keyst, tmeLoginType: loginType },
    req_0: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        uin,
        songmid: [songmid],
        songtype: [0],
        guid: buildGuid(),
        filename: filenames,
        ctx: 0,
      },
    },
  }
  const resBody = await signedRequest(payload, keyst, loginType)
  const infos = resBody.req_0?.data?.midurlinfo
  if (!infos?.length) throw mapVkeyError(resBody)
  // 诊断日志：真机验证期观察签名通道响应，稳定后移除
  console.log(`[account-source:tx] vkey(${filenames[0]}) -> req_0.code=${resBody.req_0?.code ?? '-'} msg=${resBody.req_0?.data?.msg ?? '-'} purl=${infos.some(info => info.purl) ? '有' : '无'}`)
  return infos
}

// 歌曲详情：media_mid 与 songmid 不同，直链文件名必须用 media_mid 拼接
const getSongMediaMid = async(songmid: string, uin: string, keyst: string, loginType: string): Promise<string> => {
  const payload = {
    comm: { ct: '24', cv: '0', uin, format: 'json', authst: keyst, tmeLoginType: loginType },
    req_0: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: songmid },
    },
  }
  const resBody = await signedRequest(payload, keyst, loginType)
  return resBody.req_0?.data?.track_info?.file?.media_mid ?? ''
}

// 取 purl：签名通道失败回退经典通道；无 purl 时返回 null（与风控/接口异常的抛错区分开）
const resolveInfos = async(songmid: string, mediaMid: string, filenames: string[], uin: string, keyst: string, loginType: string): Promise<Array<{ purl?: string }>> => {
  try {
    return await vkeyViaSigned(songmid, filenames, uin, keyst, loginType)
  } catch (err: Error | any) {
    console.log(`[account-source:tx] 签名通道失败(${err.message})，回退经典通道`)
    const resBody = await musicuRequest({
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: buildGuid(),
        songmid: [songmid],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    })
    const infos = resBody.req_0?.data?.midurlinfo
    if (!infos?.length) {
      if (resBody.req_0?.data?.code == 0) throw new NoSourceError('QQ音乐未返回可用音源')
      throw err
    }
    return infos
  }
}

const pickPurl = (infos: Array<{ purl?: string }>) => {
  // midurlinfo 与 filename 顺序一致（每文件名一条，空 purl = 无权限），按音质优先取第一个
  for (const info of infos) {
    if (!info.purl) continue
    const purl = info.purl
    if (/^https?:/.test(purl)) return purl
    if (purl.startsWith('//')) return `http:${purl}`
    return `http://isure.stream.qqmusic.qq.com/${purl}`
  }
  return null
}

// 经典 vkey.GetVkeyServer 模块 + GET data= 形态：明文通道现被风控大面积拒绝（500003），仅作签名通道的兜底
const musicuRequest = async(param: object) => {
  const cookie = await getCookieHeader('tx')
  const data = JSON.stringify({ req_0: param })
  const { body, statusCode } = await httpFetch<VkeyResponse>('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'GET',
    query: { format: 'json', platform: 'yqq.json', needNewCode: 0, data },
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      Cookie: cookie,
      Referer: 'https://y.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  })
  if (statusCode != 200) throw new Error(`QQ音乐接口请求失败(${statusCode})`)
  if (body?.code != 0) throw new Error(`QQ音乐接口返回异常(code=${body?.code})`)
  return body
}

const hasKeyst = (cookie: string) => {
  return cookie.includes('qm_keyst=')
}

export const validate = async() => {
  // 无轻量 profile 端点可用时，用一首稳定歌曲的无损链接可用性来校验会员凭证；
  // 探测歌曲若下架/无版权只会让结果停留在未知态，不能据此误标凭证过期
  const cookie = await getCookieHeader('tx')
  if (!parseUin(cookie) || !hasKeyst(cookie)) throw new AuthExpiredError('QQ音乐登录凭证缺失')
  await getMusicUrl({ strMediaMid: '0039MnYb0qxYhV', songmid: '0039MnYb0qxYhV' }, 'flac')
  return { ok: true }
}

export const getMusicUrl = async(songInfo: Record<string, any>, quality: LX.Quality) => {
  const cookie = await getCookieHeader('tx')
  const uin = parseUin(cookie)
  if (!uin || !hasKeyst(cookie)) throw new AuthExpiredError('QQ音乐登录凭证缺失')

  const songmid = songInfo.songmid || songInfo.strMediaMid
  if (!songmid) throw new Error('缺少QQ音乐歌曲ID')
  const keyst = parseCookieValue(cookie, 'qm_keyst')
  const loginType = parseCookieValue(cookie, 'tmeLoginType') || '2'

  const buildFiles = (mediaMid: string) => (QUALITY_FILE_PREFIXES[quality] ?? [
    { prefix: 'M500', ext: 'mp3' },
  ]).map(({ prefix, ext }) => `${prefix}${mediaMid}.${ext}`)

  // 直链文件名以 media_mid 拼接；调用方传来的 strMediaMid 与 songmid 同值时（真实 media_mid 未知），
  // 先查歌曲详情取真实 media_mid —— 否则 vkey 会照常发放，但 CDN 上该文件名实际 404
  let mediaMid = songInfo.strMediaMid || songInfo.songmid
  if (mediaMid == songmid || !songInfo.strMediaMid) {
    const realMediaMid = await getSongMediaMid(songmid, uin, keyst, loginType).catch(() => '')
    if (realMediaMid) mediaMid = realMediaMid
  }

  const infos = await resolveInfos(songmid, mediaMid, buildFiles(mediaMid), uin, keyst, loginType)
  const purl = pickPurl(infos)

  if (purl) return purl
  // “无 purl”无法区分凭证失效与歌曲无版权/下架，按无可用音源抛出走静默复核，避免单首歌误标过期
  throw new NoSourceError('QQ音乐未返回可用音源')
}
