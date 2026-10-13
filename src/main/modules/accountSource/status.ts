import { ACCOUNT_SOURCE_PLATFORMS } from './const'

const statusMap: LX.AccountSource.StatusMap = Object.fromEntries(
  ACCOUNT_SOURCE_PLATFORMS.map(platform => [platform, { login: false, status: 'unknown', updatedAt: 0 }]),
) as LX.AccountSource.StatusMap

let broadcast: ((status: LX.AccountSource.StatusMap) => void) | null = null

export const setStatusBroadcast = (fn: (status: LX.AccountSource.StatusMap) => void) => {
  broadcast = fn
}

export const getStatus = (): LX.AccountSource.StatusMap => {
  return Object.fromEntries(
    ACCOUNT_SOURCE_PLATFORMS.map(platform => [platform, { ...statusMap[platform] }]),
  ) as LX.AccountSource.StatusMap
}

export const updateStatus = (platform: LX.AccountSource.Platform, patch: Partial<LX.AccountSource.Status>) => {
  statusMap[platform] = { ...statusMap[platform], ...patch, updatedAt: Date.now() }
  broadcast?.(getStatus())
  return statusMap[platform]
}
