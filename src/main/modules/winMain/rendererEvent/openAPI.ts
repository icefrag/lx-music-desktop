import { mainHandle, mainOn } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import {
  startServer,
  stopServer,
  getStatus,
} from '@main/modules/openApi'
import { sendEvent } from '../main'


export interface SonglistDetailData {
  source: string
  id: string
  info: Record<string, unknown>
  total: number
  limit: number
  list: Array<Record<string, unknown>>
}

interface SonglistRequestParams {
  requestKey: string
  source: string
  id: string
}
interface SonglistResponseParams {
  requestKey: string
  data?: SonglistDetailData
  error?: string
}

const requestQueue = new Map<string, [(data: SonglistDetailData) => void, (err: Error) => void]>()
let requestKeyNum = 0

/**
 * 请求渲染进程拉取在线歌单数据（requestKey 往返，超时 20s）
 */
export const requestSonglist = async(source: string, id: string): Promise<SonglistDetailData> => await new Promise((resolve, reject) => {
  const requestKey = `openapi__${++requestKeyNum}__${Date.now()}`
  requestQueue.set(requestKey, [resolve, reject])
  setTimeout(() => {
    if (!requestQueue.has(requestKey)) return
    requestQueue.delete(requestKey)
    reject(new Error('request timeout'))
  }, 60000)
  sendEvent<SonglistRequestParams>(WIN_MAIN_RENDERER_EVENT_NAME.open_api_songlist_request, {
    requestKey,
    source,
    id,
  })
})


export default () => {
  mainHandle<LX.OpenAPI.Actions, any>(WIN_MAIN_RENDERER_EVENT_NAME.open_api_action, async({ params: data }) => {
    switch (data.action) {
      case 'enable':
        return data.data.enable ? await startServer(parseInt(data.data.port), data.data.bindLan) : await stopServer()
      case 'status': return getStatus()
    }
  })

  mainOn<SonglistResponseParams>(WIN_MAIN_RENDERER_EVENT_NAME.open_api_songlist_response, ({ params }) => {
    const request = requestQueue.get(params.requestKey)
    if (!request) return
    requestQueue.delete(params.requestKey)
    if (params.error) request[1](new Error(params.error))
    else if (params.data) request[0](params.data)
    else request[1](new Error('request failed'))
  })
}
