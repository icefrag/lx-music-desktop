import { closeWindow } from './main'
import { getUserApis, importApi as handleImportApi, removeApi as handleRemoveApi, setAllowShowUpdateAlert as saveAllowShowUpdateAlert } from './utils'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, init } from './rendererEvent/rendererEvent'
import initSpillChannel, { closePoolChannels } from './spillChannel'

let userApiId: string | null

export const getApiList = getUserApis

export const importApi = async(script: string): Promise<LX.UserApi.ImportUserApi> => {
  return {
    apiInfo: await handleImportApi(script),
    apiList: getUserApis(),
  }
}
export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  // 内置音源是应用基础设施（gz 快照随二进制分发、重启自动复原），不可删除；UI 藏了删除按钮，此处兜底拒绝
  const removableIds = ids.filter(id => !id.startsWith('user_api_builtin_'))
  if (userApiId && removableIds.includes(userApiId)) {
    userApiId = null
    await closeWindow()
  }
  if (removableIds.length) {
    handleRemoveApi(removableIds)
    // 被删的自定义源同时出池（ADR 0006）：销毁其沙箱，防僵尸成员继续接活
    closePoolChannels(removableIds)
  }
  return getUserApis()
}

export const setApi = async(id: string) => {
  if (userApiId) {
    userApiId = null
    await closeWindow()
  }
  const apiList = getUserApis()
  if (!apiList.some(a => a.id === id)) return
  userApiId ||= id
  await loadApi(id)
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  saveAllowShowUpdateAlert(id, enable)
  setRendererEventAllowShowUpdateAlert(id, enable)
}


export * from './rendererEvent/rendererEvent'

export default () => {
  init()
  initSpillChannel()

  global.lx.event_app.on('main_window_close', () => {
    void closeWindow()
    closePoolChannels([...getApiList().map(a => a.id)])
  })
}
