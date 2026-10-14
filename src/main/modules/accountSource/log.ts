// 账号音源诊断日志：双写控制台与 electron-log 文件。
// 正式版没有 dev 控制台，登录/校验的事件现场只存在 main.log 里（真机验证期使用，稳定后移除）。
import { log as writeLog } from '@common/utils'

export default {
  info(...params: any[]) {
    console.log(...params)
    writeLog.info(...params)
  },
}
