import fs from 'node:fs'
import path from 'node:path'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle, mainOn } from '@common/mainIpc'

// 分发/池日志按天落盘到 <userData>/logs/（global.lxDataPath 兼容便携模式），供真机排查对账
const appendDispatchLog = (line: string) => {
  try {
    const dir = path.join(global.lxDataPath, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    fs.appendFileSync(path.join(dir, `dispatch-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`), `${stamp} ${line}\n`)
  } catch (err) {
    console.error('[dispatch-log] 写入失败:', err)
  }
}

export default () => {
  // 渲染层分发决策日志透传：renderer console 在 dev stdout 不可见，统一引到主进程输出（issues/04）
  mainOn<string>(WIN_MAIN_RENDERER_EVENT_NAME.renderer_debug_log, ({ params }) => {
    console.log(params)
    appendDispatchLog(params)
  })
  mainHandle<LX.Download.ListItem[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_get, async() => {
    return global.lx.worker.dbService.getDownloadList()
  })
  mainHandle<LX.Download.saveDownloadMusicInfo>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_add, async({ params: { list, addMusicLocationType } }) => {
    await global.lx.worker.dbService.downloadInfoSave(list, addMusicLocationType)
  })
  mainHandle<LX.Download.ListItem[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_update, async({ params: list }) => {
    await global.lx.worker.dbService.downloadInfoUpdate(list)
  })
  mainHandle<string[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_remove, async({ params: ids }) => {
    await global.lx.worker.dbService.downloadInfoRemove(ids)
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.download_list_clear, async() => {
    await global.lx.worker.dbService.downloadInfoClear()
  })
}
