import crypto from 'node:crypto'
import { httpFetch } from '@main/utils/request'
import { getCookieHeader } from '../sessions'
import { AuthExpiredError, RiskControlError } from '../errors'

// 网易云 weapi 公开加密参数
const WEAPI_NONCE = '0CoJUm6Qyw8W8jud'
const WEAPI_IV = '0102030405060708'
const WEAPI_PUBKEY_EXP = '010001'
// eslint-disable-next-line max-len
const WEAPI_PUBKEY_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'

const SECRET_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789'

const rsaKey = crypto.createPublicKey({
  key: {
    kty: 'RSA',
    n: Buffer.from(WEAPI_PUBKEY_MODULUS.replace(/^00/, ''), 'hex').toString('base64url'),
    e: Buffer.from(WEAPI_PUBKEY_EXP, 'hex').toString('base64url'),
  },
  format: 'jwk',
})

const aesEncrypt = (text: string, key: string) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, WEAPI_IV)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
}

const rsaEncrypt = (secret: string) => {
  const reversed = Buffer.from(secret, 'utf8').reverse()
  const padded = Buffer.alloc(128)
  reversed.copy(padded, 128 - reversed.length)
  return crypto.publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex')
}

const weapi = (data: object) => {
  const secret = Array.from({ length: 16 }, () => SECRET_CHARSET.charAt(Math.floor(Math.random() * SECRET_CHARSET.length))).join('')
  return {
    params: aesEncrypt(aesEncrypt(JSON.stringify(data), WEAPI_NONCE), secret),
    encSecKey: rsaEncrypt(secret),
  }
}

const weapiRequest = async<T = Record<string, unknown>>(path: string, data: object) => {
  const cookie = await getCookieHeader('wy')
  const { body, statusCode } = await httpFetch<string>(`https://music.163.com${path}`, {
    method: 'POST',
    form: weapi(data),
    timeout: 10000,
    retryNum: 1,
    maxRedirect: 0,
    headers: {
      Cookie: cookie,
      Referer: 'https://music.163.com/',
      Origin: 'https://music.163.com',
    },
  })
  if (statusCode != 200) throw new Error(`网易音乐接口请求失败(${statusCode})`)
  // 共享请求工具只对 JSON Content-Type 的请求自动解析响应体，form 请求返回的是原始字符串，需手动解析
  let json: T & { code?: number }
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error('网易音乐接口返回了无法解析的数据')
  }
  if (json?.code == 301) throw new AuthExpiredError('网易音乐登录凭证已过期')
  // 460/-460 = 网易频率风控（Cheating），映射进冷却机制
  if (json?.code == 460 || json?.code == -460) throw new RiskControlError('网易音乐触发频率限制，请稍后重试')
  if (json?.code != 200) throw new Error(`网易音乐接口返回异常(code=${json?.code})`)
  return json as T
}

// 音质从高到低的降级链，目标：能下到歌最重要，音质有什么用什么
const QUALITY_LEVELS: Partial<Record<LX.Quality, string[]>> = {
  flac24bit: ['hires', 'lossless', 'exhigh'],
  flac: ['lossless', 'exhigh'],
  '320k': ['exhigh', 'standard'],
  '128k': ['standard'],
}

interface PlayerUrlData {
  data?: Array<{ url?: string | null, level?: string, code?: number }>
}

export const validate = async() => {
  const body = await weapiRequest<{ profile?: { nickname?: string } | null }>('/weapi/nuser/account/get', {})
  // 失效会话也可能返回 code 200 但 profile 为空，必须以 profile 判定登录态
  if (!body.profile) throw new AuthExpiredError('网易音乐登录凭证已过期')
  return { ok: true, nickname: body.profile.nickname }
}

export const getMusicUrl = async(songInfo: Record<string, any>, quality: LX.Quality) => {
  const songId = songInfo.songmid
  if (!songId) throw new Error('缺少网易音乐歌曲ID')
  for (const level of QUALITY_LEVELS[quality] ?? ['standard']) {
    const body = await weapiRequest<PlayerUrlData>('/weapi/song/enhance/player/url', {
      ids: [songId],
      br: 999000,
      level,
      csrf_token: '',
    })
    const item = body.data?.[0]
    if (item?.url) return item.url
  }
  throw new Error('网易音乐未返回可用音源')
}
