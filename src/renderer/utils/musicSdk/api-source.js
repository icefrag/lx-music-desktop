import apiSourceInfo from './api-source-info'
import { apiSource, userApi, accountSource } from '@renderer/store'
import { requestAccountSourceUrl } from '@renderer/utils/ipc'
// import api_temp_kw from './kw/api-temp'
// // import api_test_bd from './bd/api-test'
// import api_test_tx from './tx/api-test'
// import api_test_kg from './kg/api-test'
// import api_test_kw from './kw/api-test'
// import api_test_mg from './mg/api-test'
// import api_test_wy from './wy/api-test'

const allApi = {
  // temp_kw: api_temp_kw,
  // // test_bd: api_test_bd,
  // test_tx: api_test_tx,
  // test_kg: api_test_kg,
  // test_kw: api_test_kw,
  // test_mg: api_test_mg,
  // test_wy: api_test_wy,
}

const apiList = {}
const supportQuality = {}

for (const api of apiSourceInfo) {
  supportQuality[api.id] = api.supportQualitys
  for (const source of Object.keys(api.supportQualitys)) {
    apiList[`${api.id}_api_${source}`] = allApi[`${api.id}_${source}`]
  }
}

const getAPI = source => apiList[`${apiSource.value}_api_${source}`]

// 账号音源：登录后优先用账号解析，失败自动落回当前音源（兜底链）
const isAccountSourceActive = source => {
  const status = accountSource.status[source]
  return status?.login && status.status != 'expired'
}

// 兜底音源（不含账号层）：播放链路的回落目标；下载分发器在双通道全败后的最后尝试（ADR 0005）
const getFallbackApi = source => {
  return /^user_api/.test(apiSource.value) ? userApi.apis[source] : getAPI(source)
}

const buildAccountApi = (source, options = {}) => {
  return {
    getMusicUrl(songInfo, type) {
      return {
        canceleFn() {},
        promise: requestAccountSourceUrl({ source, type, musicInfo: songInfo }).then(
          res => ({ type, url: res.url }),
          err => {
            // 下载链路声明 noRiskControlFallback：风控冷却等账号恢复比静默降级到免费源更符合预期
            if (options.noRiskControlFallback && /^risk_control: /.test(err?.message ?? '')) throw err
            // 账号解析失败时回落到当前生效音源（user_api 或内置）
            const fallback = getFallbackApi(source)
            if (fallback?.getMusicUrl) return fallback.getMusicUrl(songInfo, type).promise
            throw err
          },
        ),
      }
    },
  }
}

const apis = (source, options) => {
  // 诊断日志：真机验证期观察取链分发路径，稳定后移除
  const active = isAccountSourceActive(source)
  console.log('[api-source] apis()', source, 'accountActive=', active, 'apiSource=', apiSource.value, 'userApiHas=', !!userApi.apis[source])
  if (active) return buildAccountApi(source, options)
  if (/^user_api/.test(apiSource.value)) return userApi.apis[source]
  let api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}

export { apis, getFallbackApi, supportQuality }
