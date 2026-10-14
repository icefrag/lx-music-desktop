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
  if (userApiId && ids.includes(userApiId)) {
    userApiId = null
    await closeWindow()
  }
  handleRemoveApi(ids)
  // 被删的自定义源同时出池（ADR 0006）：销毁其沙箱，防僵尸成员继续接活
  void closePoolChannels(ids)
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
    void closePoolChannels([...getApiList().map(a => a.id)])
  })
}
