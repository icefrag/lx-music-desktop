import http from 'node:http'
import querystring from 'node:querystring'
import type { Socket } from 'node:net'
import { getAddress } from '@common/utils/nodejs'
import { sendTaskbarButtonClick, requestSonglist } from '@main/modules/winMain'
import { getUserApis } from '@main/modules/userApi/utils'
import { getStatus as getUserApiStatus } from '@main/modules/userApi/rendererEvent/rendererEvent'

const sendResponse = (res: http.ServerResponse, code = 200, msg: string | Record<any, unknown> = 'OK', contentType = 'text/plain; charset=utf-8') => {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  })
  if (typeof msg === 'object') {
    res.end(JSON.stringify(msg))
  } else {
    res.end(msg)
  }
}

let status: LX.OpenAPI.Status = {
  status: false,
  message: '',
  address: '',
}

type SubscribeKeys = keyof LX.Player.Status

let httpServer: http.Server
let sockets = new Set<Socket>()
let responses = new Map<http.ServerResponse<http.IncomingMessage>, SubscribeKeys[]>()
let playerStatusKeys: SubscribeKeys[]

const defaultFilter = [
  'status',
  'name',
  'singer',
  'albumName',
  'lyricLineText',
  'duration',
  'progress',
  'playbackRate',
] satisfies SubscribeKeys[]

const parseFilter = (filter: any) => {
  if (typeof filter != 'string') return defaultFilter
  filter = filter.split(',')
  const subKeys = playerStatusKeys.filter(k => filter.includes(k))
  return subKeys.length ? subKeys : defaultFilter
}
const handleSendStatus = (res: http.ServerResponse<http.IncomingMessage>, query?: string) => {
  const keys = parseFilter(querystring.parse(query ?? '').filter)
  const resp: Partial<Record<SubscribeKeys, any>> = {}
  for (const k of keys) resp[k] = global.lx.player_status[k]
  sendResponse(res, 200, resp, 'application/json; charset=utf-8')
}
const handleSendAllLyric = (res: http.ServerResponse<http.IncomingMessage>) => {
  const resp: Partial<Record<SubscribeKeys, any>> = {
    lyric: global.lx.player_status.lyric,
    tlyric: global.lx.player_status.tlyric,
    rlyric: global.lx.player_status.rlyric,
    lxlyric: global.lx.player_status.lxlyric,
  }
  sendResponse(res, 200, resp, 'application/json; charset=utf-8')
}
const handleSubscribePlayerStatus = (req: http.IncomingMessage, res: http.ServerResponse<http.IncomingMessage>, query?: string) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  })
  req.socket.setTimeout(0)
  req.on('close', () => {
    res.end('OK')
    responses.delete(res)
  })
  const keys = parseFilter(querystring.parse(query ?? '').filter)
  responses.set(res, keys)
  for (const [k, v] of Object.entries(global.lx.player_status)) {
    if (!keys.includes(k as SubscribeKeys)) continue
    res.write(`event: ${k}\n`)
    res.write(`data: ${JSON.stringify(v)}\n\n`)
  }
}

const handleSonglistRequest = async(res: http.ServerResponse<http.IncomingMessage>, source: string, id: string) => {
  try {
    const data = await requestSonglist(source, id)
    sendResponse(res, 200, data as unknown as Record<any, unknown>, 'application/json; charset=utf-8')
  } catch (err: any) {
    sendResponse(res, err.message == 'request timeout' ? 504 : 500, { error: err.message }, 'application/json; charset=utf-8')
  }
}

/**
 * 下载任务状态查询：直读 dbService 的下载列表（任务状态实时落库），供调用方轮询对账
 */
const handleDownloadStatus = async(res: http.ServerResponse<http.IncomingMessage>, query?: string) => {
  try {
    const { songmids, source } = querystring.parse(query ?? '')
    const idSet = typeof songmids == 'string' && songmids
      ? new Set(songmids.split(',').map(sid => sid.trim()).filter(Boolean))
      : null
    const tasks = (await global.lx.worker.dbService.getDownloadList()).filter(item => {
      if (idSet && !idSet.has(String(item.metadata.musicInfo.meta.songId))) return false
      if (typeof source == 'string' && source && item.metadata.musicInfo.source != source) return false
      return true
    })
    const list = tasks.map(item => ({
      songmid: String(item.metadata.musicInfo.meta.songId),
      source: item.metadata.musicInfo.source,
      name: item.metadata.musicInfo.name,
      singer: item.metadata.musicInfo.singer,
      status: item.status,
      statusText: item.statusText,
      errorCode: item.errorCode ?? null,
      apiSource: item.metadata.apiSource ?? null,
      fileName: item.metadata.fileName,
      filePath: item.metadata.filePath,
      quality: item.metadata.quality,
      ext: item.metadata.ext,
      progress: item.progress,
      downloaded: item.downloaded,
      total: item.total,
    }))
    sendResponse(res, 200, { list }, 'application/json; charset=utf-8')
  } catch (err: any) {
    sendResponse(res, 500, { error: err.message }, 'application/json; charset=utf-8')
  }
}

/**
 * 音源查询/切换/别名绑定：
 * - set：接受别名或原始 id，切换走官方设置链路（渲染进程重载脚本窗口）并等待就绪（最长 15s）
 * - alias：把别名绑定到指定音源（id 缺省为当前音源）。音源 id 在导入时生成、重导入会变，
 *   调用方绑定一次别名后即可始终用固定枚举切换，音源重导入后重新绑定即可
 */
const handleApiSource = async(res: http.ServerResponse<http.IncomingMessage>, params: { set?: string, alias?: string, id?: string }) => {
  try {
    const apis = getUserApis()
    let aliases: Record<string, string> = {}
    try {
      aliases = JSON.parse(global.lx.appSetting['openAPI.apiSourceAliases'] || '{}')
    } catch {} // 容忍损坏的映射串，按空处理
    const resolveId = (key?: string) => {
      if (key == null) return undefined
      if (apis.some(api => api.id == key)) return key
      return aliases[key] != null && apis.some(api => api.id == aliases[key]) ? aliases[key] : undefined
    }

    // 先应用别名绑定（同请求内即可用新别名 set），再解析 set
    // id 显式给出但无法解析 → 400；id 缺省 → 绑到当前音源（当前须为有效音源）
    const current = global.lx.appSetting['common.apiSource']
    let bindTarget = resolveId(params.id)
    if (params.id != null && bindTarget == null) {
      sendResponse(res, 400, { error: 'Unknown api source id to bind' }, 'application/json; charset=utf-8')
      return
    }
    if (params.id == null) bindTarget = apis.some(api => api.id == current) ? current : undefined
    if (params.alias != null && bindTarget == null) {
      sendResponse(res, 400, { error: 'Unknown api source id to bind' }, 'application/json; charset=utf-8')
      return
    }
    const newSetting: Partial<LX.AppSetting> = {}
    if (params.alias != null) {
      aliases[params.alias] = bindTarget!
      newSetting['openAPI.apiSourceAliases'] = JSON.stringify(aliases)
    }
    const set = resolveId(params.set)
    if (params.set != null && set == null) {
      sendResponse(res, 400, { error: 'Unknown api source id or alias' }, 'application/json; charset=utf-8')
      return
    }
    if (set != null && current != set) newSetting['common.apiSource'] = set
    if (Object.keys(newSetting).length) global.lx.event_app.update_config(newSetting)

    if (newSetting['common.apiSource'] != null) {
      const start = Date.now()
      while (Date.now() - start < 15000) {
        const status = getUserApiStatus()
        if (status.status && status.apiInfo?.id == set) break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    const aliasOf = (id: string) => Object.keys(aliases).find(key => aliases[key] == id) ?? null
    // ready = 当前音源的脚本已就绪（apiInfo.id 与当前一致；未加载过脚本时初始状态恒不匹配）
    const status = getUserApiStatus()
    sendResponse(res, 200, {
      current: global.lx.appSetting['common.apiSource'],
      ready: status.status == true && status.apiInfo?.id == global.lx.appSetting['common.apiSource'],
      list: apis.map(({ id, name, version, description }) => ({ id, name, version, description, alias: aliasOf(id) })),
    }, 'application/json; charset=utf-8')
  } catch (err: any) {
    sendResponse(res, 500, { error: err.message }, 'application/json; charset=utf-8')
  }
}

const handleStartServer = async(port: number, ip: string) => new Promise<void>((resolve, reject) => {
  playerStatusKeys = Object.keys(global.lx.player_status) as SubscribeKeys[]
  httpServer = http.createServer((req, res): void => {
    const [endUrl, query] = `/${req.url?.split('/').at(-1) ?? ''}`.split('?')
    let code = 200
    let msg = 'OK'
    switch (endUrl) {
      case '/status':
        handleSendStatus(res, query)
        return
        // case '/test':
        //   code = 200
        //   res.setHeader('Content-Type', 'text/html; charset=utf-8')
        //   msg = `<!DOCTYPE html>
        //   <html lang="en">
        //     <head>
        //       <meta charset="UTF-8" />
        //       <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        //       <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        //       <title>Nodejs Server-Sent Events</title>
        //     </head>
        //     <body>
        //       <h1>Hello SSE!</h1>

        //       <h2>List of Server-sent events</h2>
        //       <ul id="sse-list"></ul>

        //       <script>
        //         const subscription = new EventSource('/subscribe-player-status');

        //       // Default events
        //       subscription.addEventListener('open', () => {
        //           console.log('Connection opened')
        //       });

      //       subscription.addEventListener('error', (err) => {
      //           console.error(err)
      //       });
      //       subscription.addEventListener('lyricLineText', (event) => {
      //           console.log(event.data)
      //       });
      //       subscription.addEventListener('progress', (event) => {
      //           console.log(event.data)
      //       });
      //       subscription.addEventListener('name', (event) => {
      //           console.log(event.data)
      //       });
      //       subscription.addEventListener('singer', (event) => {
      //           console.log(event.data)
      //       });
      //       </script>
      //     </body>
      //   </html>`
      //   break
      case '/lyric':
        msg = global.lx.player_status.lyric
        break
      case '/lyric-all':
        handleSendAllLyric(res)
        return
      case '/play':
        sendTaskbarButtonClick('play')
        break
      case '/pause':
        sendTaskbarButtonClick('pause')
        break
      case '/skip-next':
        sendTaskbarButtonClick('next')
        break
      case '/skip-prev':
        sendTaskbarButtonClick('prev')
        break
      case '/seek': {
        const offset = parseFloat(querystring.parse(query ?? '').offset as string)
        if (Number.isNaN(offset) || offset < 0 || offset > global.lx.player_status.duration) {
          code = 400
          msg = 'Invalid offset'
        } else {
          sendTaskbarButtonClick('seek', parseFloat(offset.toFixed(3)))
        }
        break
      }
      case '/collect':
        sendTaskbarButtonClick('collect')
        break
      case '/uncollect':
        sendTaskbarButtonClick('unCollect')
        break
      case '/volume': {
        const volume = parseInt(querystring.parse(query ?? '').volume as string)
        if (Number.isNaN(volume) || volume < 0 || volume > 100) {
          code = 400
          msg = 'Invalid volume'
        } else {
          sendTaskbarButtonClick('volume', volume / 100)
        }
        break
      }
      case '/open-songlist': {
        const { source, id } = querystring.parse(query ?? '')
        if (!source || !id) {
          code = 400
          msg = 'Invalid params: source and id required'
        } else {
          // 走 deeplink path 段传值，规避解析器不解码 query 值的问题
          global.lx.event_app.deeplink(`lxmusic://songlist/open/${source as string}/${encodeURIComponent(id as string)}`)
        }
        break
      }
      case '/songlist': {
        const { source, id } = querystring.parse(query ?? '')
        if (!source || !id) {
          code = 400
          msg = 'Invalid params: source and id required'
          break
        }
        void handleSonglistRequest(res, source as string, id as string)
        return
      }
      case '/download-songlist': {
        const { source, id, songmids, quality, limit, dir } = querystring.parse(query ?? '')
        if (!source || !id) {
          code = 400
          msg = 'Invalid params: source and id required'
          break
        }
        const data: Record<string, unknown> = {
          source,
          id,
          quality: typeof quality == 'string' && quality ? quality : '320k',
        }
        if (typeof songmids == 'string' && songmids) data.songmids = songmids.split(',').map(sid => sid.trim()).filter(Boolean)
        const limitNum = parseInt(limit as string)
        if (!Number.isNaN(limitNum) && limitNum > 0) data.limit = limitNum
        if (typeof dir == 'string' && dir) data.dir = dir
        global.lx.event_app.deeplink(`lxmusic://songlist/download?data=${encodeURIComponent(JSON.stringify(data))}`)
        break
      }
      case '/download-music': {
        const { source, name, singer, songmid, albumName, interval, quality, hash, copyrightId, strMediaMid, dir } = querystring.parse(query ?? '')
        if (!source || !name || !singer || !songmid) {
          code = 400
          msg = 'Invalid params: source, name, singer, songmid required'
          break
        }
        const musicInfo: Record<string, unknown> = {
          name,
          singer,
          source,
          songmid,
          // qualityFilter 会按源可用性过滤，不可用则回退 128k
          types: [{ type: quality ?? '320k', size: null, ...(hash ? { hash } : {}) }],
        }
        if (albumName) musicInfo.albumName = albumName
        if (interval) musicInfo.interval = interval
        if (hash) musicInfo.hash = hash // kg 源必填
        if (copyrightId) musicInfo.copyrightId = copyrightId // mg 源必填
        if (strMediaMid) musicInfo.strMediaMid = strMediaMid // tx 源必填
        const data: Record<string, unknown> = { ...musicInfo }
        if (typeof quality == 'string' && quality) data.quality = quality
        if (typeof dir == 'string' && dir) data.dir = dir
        global.lx.event_app.deeplink(`lxmusic://music/download?data=${encodeURIComponent(JSON.stringify(data))}`)
        break
      }
      case '/api-source': {
        const { set, alias, id } = querystring.parse(query ?? '')
        void handleApiSource(res, {
          set: typeof set == 'string' && set ? set : undefined,
          alias: typeof alias == 'string' && alias ? alias : undefined,
          id: typeof id == 'string' && id ? id : undefined,
        })
        return
      }
      case '/download-status': {
        void handleDownloadStatus(res, query)
        return
      }
      case '/mute': {
        const mute = querystring.parse(query ?? '').mute
        if (mute == 'true') {
          sendTaskbarButtonClick('mute', true)
        } else if (mute == 'false') {
          sendTaskbarButtonClick('mute', false)
        } else {
          code = 400
          msg = 'Invalid mute value'
        }
        break
      }
      case '/subscribe-player-status':
        try {
          handleSubscribePlayerStatus(req, res, query)
          return
        } catch (err) {
          console.log(err)
          code = 500
          msg = 'Error'
        }
        break
      default:
        code = 401
        msg = 'Forbidden'
        break
    }
    sendResponse(res, code, msg)
  })
  httpServer.on('error', error => {
    console.log(error)
    reject(error)
  })
  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
    })
    socket.setTimeout(4000)
  })

  httpServer.on('listening', () => {
    const addr = httpServer.address()
    // console.log(addr)
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    resolve()
  })
  httpServer.listen(port, ip)
})

const handleStopServer = async() => new Promise<void>((resolve, reject) => {
  if (!httpServer) return
  httpServer.close((err) => {
    if (err) {
      reject(err)
      return
    }
    resolve()
  })
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  responses.clear()
})


const sendStatus = (status: Partial<LX.Player.Status>) => {
  if (!responses.size) return
  for (const [resp, keys] of responses) {
    for (const [k, v] of Object.entries(status)) {
      if (!keys.includes(k as SubscribeKeys)) continue
      resp.write(`event: ${k}\n`)
      resp.write(`data: ${JSON.stringify(v)}\n\n`)
    }
  }
}
export const stopServer = async() => {
  global.lx.event_app.off('player_status', sendStatus)
  if (!status.status) {
    status.status = false
    status.message = ''
    status.address = ''
    return status
  }
  await handleStopServer().then(() => {
    status.status = false
    status.message = ''
    status.address = ''
  }).catch(err => {
    console.log(err)
    status.message = err.message
  })
  return status
}
export const startServer = async(port: number, bindLan: boolean) => {
  if (status.status) await stopServer()
  await handleStartServer(port, bindLan ? '0.0.0.0' : '127.0.0.1').then(() => {
    status.status = true
    status.message = ''
    let address = ['127.0.0.1']
    if (bindLan) address = [...address, ...getAddress()]
    status.address = address.join(', ')
  }).catch(err => {
    console.log(err)
    status.status = false
    status.message = err.message
    status.address = ''
  })
  global.lx.event_app.on('player_status', sendStatus)
  return status
}

export const getStatus = (): LX.OpenAPI.Status => status
