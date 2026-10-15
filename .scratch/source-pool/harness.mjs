// LX user-api 脚本可用性测试架：vm 里复刻 preload 的 globalThis.lx 环境，
// 跑 init 握手拿平台/音质声明，再用已知歌曲 ID 实测 musicUrl 128k。
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCRIPTS_DIR = path.join(__dirname, 'scripts')
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['sixyin', 'huibq', 'flower', 'lx', 'changqing', 'huanyin', 'ikun', 'grass', 'juhe', 'qdy']

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']
// `脚本名:平台,平台` 语法：强制实测声明之外的平台（脚本 sources 声明可能窄于后端真实能力）
const FORCE = new Map(NAMES.map(n => {
  const [name, sources] = n.split(':')
  return [name, sources?.split(',').filter(s => ALL_SOURCES.includes(s)) ?? null]
}))
const SUPPORT_QUALITYS = ['128k', '320k', 'flac', 'flac24bit']
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

// 测试歌曲（晴天）：只实测有可靠 ID 的平台
// kg hash / kw songmid / mg songmid 来自各平台公开搜索接口（2026-10-15 查询）
const TEST_CASES = {
  wy: { songmid: '186016' },
  tx: { songmid: '0039MnYb0qxYhV', strMediaMid: '0039MnYb0qxYhV', songId: '368056904' },
  kg: { songmid: 'b3a52a7a958bf0aed0ebfba2e9a818b7', hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7' },
  kw: { songmid: '228908' },
  mg: { songmid: '3790007' },
}

const buildOldMusicInfo = (source) => {
  const info = {
    name: '晴天', singer: '周杰伦', source, songmid: '', interval: '04:29',
    albumName: '叶惠美', img: '', typeUrl: {}, albumId: '', types: ['128k'], _types: { '128k': { t: '128k', s: '标准' } },
  }
  const t = TEST_CASES[source]
  Object.assign(info, t)
  return info
}

// ---- needle 风格 request 复刻 ----
const urlencoded = (obj) => new URLSearchParams(
  Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
).toString()

const multipart = (obj) => {
  const boundary = '----lxharness' + crypto.randomBytes(8).toString('hex')
  const parts = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && 'buffer' in v) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.name ?? 'file'}"\r\nContent-Type: ${v.mime ?? 'application/octet-stream'}\r\n\r\n`))
      parts.push(v.buffer, Buffer.from('\r\n'))
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

const lxRequest = (url, { method = 'get', timeout, headers = {}, body, form, formData } = {}, callback) => {
  if (process.env.HARNESS_DEBUG) console.error(`[req] ${method.toUpperCase()} ${url} headers=${JSON.stringify(headers)}`)
  const ctrl = new AbortController()
  const ms = typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60_000) : 60_000
  const timer = setTimeout(() => ctrl.abort(new Error(`Request timed out after ${ms}ms`)), ms)
  ;(async() => {
    const opts = { method: method.toUpperCase(), headers: { ...headers }, signal: ctrl.signal, redirect: 'follow' }
    let data
    if (body !== undefined) {
      data = body
      if (typeof body === 'object' && !(body instanceof Buffer) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && !(typeof body === 'string')) {
        data = JSON.stringify(body)
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) opts.headers['Content-Type'] = 'application/json'
      }
    } else if (form !== undefined) {
      data = urlencoded(form)
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (formData !== undefined) {
      const m = multipart(formData)
      data = m.body
      opts.headers['Content-Type'] = m.contentType
    }
    if (data !== undefined) opts.body = data
    try {
      const resp = await fetch(url, opts)
      const raw = Buffer.from(await resp.arrayBuffer())
      let bodyStr = raw.toString()
      let parsed = bodyStr
      try { parsed = JSON.parse(bodyStr) } catch(_) {}
      if (process.env.HARNESS_DEBUG) console.error(`[resp] ${resp.status} ${url.slice(0, 90)} body=${JSON.stringify(parsed)?.slice(0, 160)}`)
      callback(null, { statusCode: resp.status, statusMessage: resp.statusText, headers: Object.fromEntries(resp.headers), bytes: raw.length, raw, body: parsed }, parsed)
    } catch (err) {
      callback(err.name === 'AbortError' ? new Error(err.cause?.message ?? err.message) : err, null, null)
    } finally {
      clearTimeout(timer)
    }
  })()
  return () => { clearTimeout(timer); try { ctrl.abort(new Error('aborted')) } catch(_) {} }
}

const makeLxMock = (scriptName, log, scriptMeta = {}, rawScript = '') => {
  let requestHandler = null
  let isInit = false
  let showedUpdate = false
  let initResolve, initReject
  const initPromise = new Promise((res, rej) => { initResolve = res; initReject = rej })
  const rawInitInfo = { current: null }

  const lx = {
    EVENT_NAMES,
    request: lxRequest,
    version: '2.0.0',
    env: 'desktop',
    // version/rawScript 必须真实：野花/野草类脚本按 currentScriptInfo.version 查 vinfo、按 rawScript 做 md5 校验
    currentScriptInfo: { name: scriptName, description: '', version: scriptMeta.version ?? '', author: scriptMeta.author ?? '', homepage: '', rawScript },
    send(eventName, data) {
      if (eventName === EVENT_NAMES.inited) {
        if (isInit) return Promise.reject(new Error('Script is inited'))
        isInit = true
        rawInitInfo.current = data
        if (!data || typeof data !== 'object') { initReject(new Error('Missing required parameter init info')); return Promise.resolve() }
        const sources = {}
        for (const s of ALL_SOURCES) {
          const us = data.sources?.[s]
          if (!us || us.type !== 'music') continue
          sources[s] = {
            type: 'music',
            actions: ['musicUrl'].filter(a => us.actions?.includes(a)),
            qualitys: SUPPORT_QUALITYS.filter(q => us.qualitys?.includes(q)),
          }
        }
        log(`inited: ${JSON.stringify(data.sources ?? data).slice(0, 300)}`)
        initResolve(sources)
        return Promise.resolve()
      }
      if (eventName === EVENT_NAMES.updateAlert) {
        if (showedUpdate) return Promise.reject(new Error('once only'))
        showedUpdate = true
        log(`updateAlert: ${JSON.stringify(data).slice(0, 160)}`)
        return Promise.resolve()
      }
      return Promise.reject(new Error('Unknown event name: ' + eventName))
    },
    on(eventName, handler) {
      if (eventName !== EVENT_NAMES.request) return Promise.reject(new Error('unsupported event ' + eventName))
      requestHandler = handler
      return Promise.resolve()
    },
    utils: {
      crypto: {
        aesEncrypt(buffer, mode, key, iv) { const c = crypto.createCipheriv(mode, key, iv); return Buffer.concat([c.update(buffer), c.final()]) },
        rsaEncrypt(buffer, key) { buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]); return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer) },
        randomBytes: (n) => crypto.randomBytes(n),
        md5: (s) => crypto.createHash('md5').update(s).digest('hex'),
      },
      buffer: {
        from: (...a) => Buffer.from(...a),
        bufToString: (b, f) => Buffer.from(b, 'binary').toString(f),
      },
      zlib: {
        inflate: (b) => new Promise((res, rej) => zlib.inflate(b, (e, d) => e ? rej(new Error(e.message)) : res(d))),
        deflate: (d) => new Promise((res, rej) => zlib.deflate(d, (e, b) => e ? rej(new Error(e.message)) : res(b))),
      },
    },
  }
  return { lx, initPromise, getRequestHandler: () => requestHandler, rawInitInfo, get isInit() { return isInit } }
}

const parseHeaderMeta = (script) => {
  const m = script.match(/@name\s*([^\r\n*]+)/)
  const v = script.match(/@version\s*([^\r\n*]+)/)
  const a = script.match(/@author\s*([^\r\n*]+)/)
  return { name: m?.[1]?.trim(), version: v?.[1]?.trim(), author: a?.[1]?.trim() }
}

const testScript = async(name, forced = null) => {
  const result = { id: name, meta: {}, init: null, platforms: {}, errors: [] }
  const scriptPath = path.join(SCRIPTS_DIR, `${name}.js`)
  if (!fs.existsSync(scriptPath) || fs.statSync(scriptPath).size === 0) {
    result.init = { ok: false, message: '脚本文件缺失' }
    return result
  }
  const script = fs.readFileSync(scriptPath, 'utf8')
  result.meta = parseHeaderMeta(script)
  result.meta.size = script.length

  const logs = []
  const log = (m) => logs.push(m)
  const mock = makeLxMock(name, log, result.meta, script)

  const fmt = (...a) => a.map(x => typeof x === 'object' ? JSON.stringify(x)?.slice(0, 120) : String(x)?.slice(0, 120)).join(' ')
  const noopGroup = { groupEnd() {}, end() {} }
  const sandbox = {
    console: {
      log: (...a) => log('console: ' + fmt(...a)),
      warn: (...a) => log('console.warn: ' + fmt(...a)),
      error: (...a) => log('console.error: ' + fmt(...a)),
      info: (...a) => log('console: ' + fmt(...a)),
      debug: () => {}, dir: () => {}, trace: () => {}, table: () => {},
      group: (...a) => { log('console.group: ' + fmt(...a)); return noopGroup },
      groupCollapsed: (...a) => { log('console.group: ' + fmt(...a)); return noopGroup },
      groupEnd: () => {},
      time: () => {}, timeEnd: () => {}, timeLog: () => {},
      assert: () => {}, count: () => {}, countReset: () => {}, clear: () => {},
    },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, fetch,
    performance, structuredClone,
    location: { href: 'about:blank', protocol: 'about:' },
    navigator: { userAgent: 'lx-music-request/2.0.0' },
    lx: mock.lx,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox

  const onUnrej = (reason) => {
    if (!mock.isInit) result.errors.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  process.on('unhandledRejection', onUnrej)

  try {
    vm.createContext(sandbox)
    vm.runInContext(script, sandbox, { filename: `${name}.js`, timeout: 5000 })
  } catch (err) {
    result.init = { ok: false, message: `脚本执行异常: ${err.message}` }
    process.off('unhandledRejection', onUnrej)
    return result
  }

  try {
    const sources = await Promise.race([
      mock.initPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('init 超时(30s)')), 30_000)),
    ])
    result.init = { ok: true, sources }
  } catch (err) {
    result.init = { ok: false, message: err.message }
    result.logs = logs.slice(0, 10)
    process.off('unhandledRejection', onUnrej)
    return result
  }
  process.off('unhandledRejection', onUnrej)

  const handler = mock.getRequestHandler()
  if (!handler) {
    result.requestHandler = false
    return result
  }
  result.requestHandler = true

  for (const source of forced ?? Object.keys(result.init.sources)) {
    const info = result.init.sources[source]
    if (!forced && (!info?.actions.includes('musicUrl') || !info?.qualitys.includes('128k'))) {
      result.platforms[source] = { declared: info, test: 'skip(无 musicUrl/128k)' }
      continue
    }
    if (!TEST_CASES[source]) {
      result.platforms[source] = { declared: info, test: 'untested(缺测试歌曲ID)' }
      continue
    }
    try {
      const url = await Promise.race([
        handler({ source, action: 'musicUrl', info: { type: '128k', musicInfo: buildOldMusicInfo(source) } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('请求超时(35s)')), 35_000)),
      ])
      if (typeof url === 'string' && /^https?:/.test(url)) {
        result.platforms[source] = { declared: info, test: 'OK', url: url.slice(0, 90) }
      } else {
        result.platforms[source] = { declared: info, test: 'FAIL', message: `返回非法: ${String(url).slice(0, 120)}` }
      }
    } catch (err) {
      result.platforms[source] = { declared: info, test: 'FAIL', message: err.message?.slice(0, 160) }
    }
  }
  result.logs = logs.slice(0, 10)
  return result
}

const all = await Promise.all(NAMES.map(async n => {
  const name = n.split(':')[0]
  const run = () => testScript(name, FORCE.get(name)).catch(e => ({ id: n, init: { ok: false, message: 'harness 异常: ' + e.message } }))
  let r = await run()
  if (r.init && !r.init.ok) {
    const r2 = await run()
    r2.retried = true
    r = r2
  }
  return r
}))
fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(all, null, 2))
for (const r of all) {
  console.log('\n====', r.id, JSON.stringify(r.meta))
  console.log('  init:', r.init?.ok ? 'OK' : `FAIL: ${r.init?.message}`)
  if (r.init?.ok) {
    console.log('  requestHandler:', r.requestHandler)
    for (const [s, p] of Object.entries(r.platforms ?? {})) {
      console.log(`  ${s}: ${p.test}${p.message ? ' | ' + p.message : ''}${p.url ? ' | ' + p.url : ''} | 声明音质: ${p.declared?.qualitys?.join(',')}`)
    }
  }
  if (r.logs?.length) console.log('  logs:', r.logs.slice(0, 5).join(' || ').slice(0, 400))
}
