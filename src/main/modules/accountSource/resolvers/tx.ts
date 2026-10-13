import crypto from 'node:crypto'
import { httpFetch } from '@main/utils/request'
import { getCookieHeader } from '../sessions'
import { AuthExpiredError, NoSourceError } from '../errors'

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

interface VkeyResponse {
  code?: number
  req_1?: {
    code?: number
    data?: {
      code?: number
      midurlinfo?: Array<{ purl?: string, vkey?: string, filename?: string }>
    }
  }
}

// zzc 签名：QQ音乐移动端 musics.fcg 通道所需（网页明文 musicu.fcg 已被限制，GetVkey 恒报 req_1.code 500003）；
// 复刻自本仓库 musicSdk/tx/utils/crypto.js
const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]

const zzcSign = (text: string) => {
  const hash = crypto.createHash('sha1').update(text, 'utf8').digest('hex')
  const part1 = PART_1_INDEXES.map(idx => hash[idx]).join('')
  const part2 = PART_2_INDEXES.map(idx => hash[idx]).join('')
  const bytes = Buffer.from(SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16)))
  const b64Part = bytes.toString('base64').replace(/[\\/+=]/g, '')
  return `zzc${part1}${b64Part}${part2}`.toLowerCase()
}

const musicuRequest = async(param: object) => {
  const cookie = await getCookieHeader('tx')
  const body = JSON.stringify({ req_1: param })
  const { body: resBody, statusCode } = await httpFetch<VkeyResponse>('https://u.y.qq.com/cgi-bin/musics.fcg', {
    method: 'POST',
    query: { sign: zzcSign(body) },
    text: body,
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'QQMusic 14090508(android 12)',
      Cookie: cookie,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
    },
  })
  if (statusCode != 200) throw new Error(`QQ音乐接口请求失败(${statusCode})`)
  if (resBody?.code != 0) throw new Error(`QQ音乐接口返回异常(code=${resBody?.code})`)
  return resBody
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

  const songmid = songInfo.strMediaMid || songInfo.songmid
  if (!songmid) throw new Error('缺少QQ音乐歌曲ID')

  const files = (QUALITY_FILE_PREFIXES[quality] ?? [
    { prefix: 'M500', ext: 'mp3' },
  ]).map(({ prefix, ext }) => `${prefix}${songmid}.${ext}`)

  const body = await musicuRequest({
    module: 'music.vkey.GetVkeyServerBase',
    method: 'CgiGetVkey',
    param: {
      guid: buildGuid(),
      songmid: [songmid],
      songtype: [0],
      uin,
      loginflag: 1,
      platform: '20',
      filename: files,
    },
  })
  const data = body.req_1?.data
  // midurlinfo 与 filename 顺序一致，取第一个拿到 purl 的档位
  for (const info of data?.midurlinfo ?? []) {
    if (!info.purl) continue
    const purl = info.purl
    if (/^https?:/.test(purl)) return purl
    if (purl.startsWith('//')) return `http:${purl}`
    return `http://${purl}`
  }
  // “无 purl”无法区分凭证失效与歌曲无版权/下架，按无可用音源抛出走静默复核，避免单首歌误标过期
  if (data?.code == 0) throw new NoSourceError('QQ音乐未返回可用音源')
  throw new Error(`QQ音乐接口返回异常(code=${data?.code})`)
}
