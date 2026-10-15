import {
  downloadTasksGet,
  // downloadListClear,
  downloadTasksCreate,
  downloadTasksRemove,
  downloadTasksUpdate,
  logToMain,
} from '@renderer/utils/ipc'
import {
  downloadList,
} from './state'
import { markRaw, toRaw, watch } from '@common/utils/vueTools'
import { getMusicUrl, getPicUrl, getLyricInfo } from '@renderer/core/music/online'
import { appSetting } from '../setting'
import { accountSource, apiSource, qualityList, userApi } from '..'
import { proxyCallback } from '@renderer/worker/utils'
import { arrPush, arrUnshift, joinPath, toOldMusicInfo } from '@renderer/utils'
import { getFallbackApi } from '@renderer/utils/musicSdk/api-source'
import { DOWNLOAD_STATUS } from '@common/constants'
import { proxy } from '../index'
import { buildSavePath } from './utils'
import { poolMemberReportDownload, SPILL_API_ID } from './spillChannel'
import { earliestRecovery, isAccountSourceActive, isDispatchEligible, isPlatformCoolingDown, pickProvider, resolveViaProvider } from './providerPool'

const waitingUpdateTasks = new Map<string, LX.Download.ListItem>()
let timer: NodeJS.Timeout | null = null
const throttleUpdateTask = (tasks: LX.Download.ListItem[]) => {
  for (const task of tasks) waitingUpdateTasks.set(task.id, toRaw(task))
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void downloadTasksUpdate(Array.from(waitingUpdateTasks.values()))
    waitingUpdateTasks.clear()
  }, 100)
}

const runingTask = new Map<string, LX.Download.ListItem>()

// 统一供给池分发（ADR 0007）：单次解析最多尝试的供给源数（等价 0005 时代 账号1+池2 的转移预算）
const DISPATCH_BUDGET = 3
// 恢复期退回等待的任务的最早重试时间：到点前 getStartTask 不重选（唤醒交给恢复定时器）
const channelWaitRetryAt = new Map<string, number>()
// 恢复期等待轮数上限：通道反复恢复失败的任务最终报错，而非无限空转
const CHANNEL_WAIT_MAX = 3
const channelWaitCount = new Map<string, number>()

// const initDownloadList = (list: LX.Download.ListItem[]) => {
//   downloadList.splice(0, downloadList.length, ...list)
// }

export const getDownloadList = async(): Promise<LX.Download.ListItem[]> => {
  if (!downloadList.length) {
    const list = await downloadTasksGet()
    for (const downloadInfo of list) {
      markRaw(downloadInfo.metadata)
      switch (downloadInfo.status) {
        case DOWNLOAD_STATUS.RUN:
        case DOWNLOAD_STATUS.WAITING:
          downloadInfo.status = DOWNLOAD_STATUS.PAUSE
          downloadInfo.statusText = window.i18n.t('download___status_paused')
        default:
          break
      }
    }
    arrPush(downloadList, list)
  }
  return downloadList
}

const addTasks = async(list: LX.Download.ListItem[]) => {
  const addMusicLocationType = appSetting['list.addMusicLocationType']

  await downloadTasksCreate(list.map(i => toRaw(i)), addMusicLocationType)

  if (addMusicLocationType === 'top') {
    arrUnshift(downloadList, list)
  } else {
    arrPush(downloadList, list)
  }
  window.app_event.downloadListUpdate()
}

const setStatusText = (downloadInfo: LX.Download.ListItem, text: string) => { // 设置状态文本
  downloadInfo.statusText = text
  throttleUpdateTask([downloadInfo])
}

const setUrl = (downloadInfo: LX.Download.ListItem, url: string) => {
  downloadInfo.metadata.url = url
  throttleUpdateTask([downloadInfo])
}

const updateFilePath = (downloadInfo: LX.Download.ListItem, filePath: string) => {
  downloadInfo.metadata.filePath = filePath
  throttleUpdateTask([downloadInfo])
}

const setProgress = (downloadInfo: LX.Download.ListItem, progress: LX.Download.ProgressInfo) => {
  downloadInfo.total = progress.total
  downloadInfo.downloaded = progress.downloaded
  downloadInfo.writeQueue = progress.writeQueue
  if (progress.progress == 100) {
    downloadInfo.speed = ''
    downloadInfo.progress = 99.99
    setStatusText(downloadInfo, window.i18n.t('download_status_write_queue', { num: progress.writeQueue }))
  } else {
    downloadInfo.speed = progress.speed
    downloadInfo.progress = progress.progress
  }
  throttleUpdateTask([downloadInfo])
}

const setStatus = (downloadInfo: LX.Download.ListItem, status: LX.Download.DownloadTaskStatus, statusText?: string) => { // 设置状态及状态文本
  if (statusText == null) {
    switch (status) {
      case DOWNLOAD_STATUS.RUN:
        statusText = window.i18n.t('download___status_running')
        break
      case DOWNLOAD_STATUS.WAITING:
        statusText = window.i18n.t('download___status_waiting')
        break
      case DOWNLOAD_STATUS.PAUSE:
        statusText = window.i18n.t('download___status_paused')
        break
      case DOWNLOAD_STATUS.ERROR:
        statusText = window.i18n.t('download___status_error')
        break
      case DOWNLOAD_STATUS.COMPLETED:
        statusText = window.i18n.t('download___status_completed')
        break
      default:
        statusText = ''
        break
    }
  }

  if (downloadInfo.statusText == statusText && downloadInfo.status == status) return

  if (status == DOWNLOAD_STATUS.COMPLETED) downloadInfo.isComplate = true
  if (status != DOWNLOAD_STATUS.ERROR) downloadInfo.errorCode = undefined
  downloadInfo.statusText = statusText
  downloadInfo.status = status
  throttleUpdateTask([downloadInfo])
}

// 修复 1.1.x版本 酷狗源歌词格式
const fixKgLyric = (lrc: string) => /\[00:\d\d:\d\d.\d+\]/.test(lrc) ? lrc.replace(/(?:\[00:(\d\d:\d\d.\d+\]))/gm, '[$1') : lrc

const getProxy = () => {
  return proxy.enable && proxy.host ? {
    host: proxy.host,
    port: parseInt(proxy.port || '80'),
  } : proxy.envProxy ? {
    host: proxy.envProxy.host,
    port: parseInt(proxy.envProxy.port || '80'),
  } : undefined
}
/**
 * 设置歌曲meta信息
 * @param downloadInfo 下载任务信息
 */
const saveMeta = (downloadInfo: LX.Download.ListItem) => {
  if (downloadInfo.metadata.quality === 'ape') return
  const isUseOtherSource = appSetting['download.isUseOtherSource']
  const tasks: [Promise<string | null>, Promise<LX.Player.LyricInfo | null>] = [
    appSetting['download.isEmbedPic']
      ? downloadInfo.metadata.musicInfo.meta.picUrl
        ? Promise.resolve(downloadInfo.metadata.musicInfo.meta.picUrl)
        : getPicUrl({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
          console.log(err)
          return null
        })
      : Promise.resolve(null),
    appSetting['download.isEmbedLyric']
      ? getLyricInfo({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
        console.log(err)
        return null
      })
      : Promise.resolve(null),
  ]
  void Promise.all(tasks).then(([imgUrl, lyrics]) => {
    const info = {
      filePath: downloadInfo.metadata.filePath,
      isEmbedLyricLx: appSetting['download.isEmbedLyricLx'],
      isEmbedLyricT: appSetting['download.isEmbedLyricT'],
      isEmbedLyricR: appSetting['download.isEmbedLyricR'],
      title: downloadInfo.metadata.musicInfo.name,
      artist: downloadInfo.metadata.musicInfo.singer?.replaceAll('、', ';'),
      album: downloadInfo.metadata.musicInfo.meta.albumName,
      APIC: imgUrl,
    }
    void window.lx.worker.download.writeMeta(info, lyrics ?? { lyric: '' }, getProxy())
  })
}

/**
 * 保存歌词文件
 * @param downloadInfo 下载任务信息
 */
const downloadLyric = (downloadInfo: LX.Download.ListItem) => {
  if (!appSetting['download.isDownloadLrc']) return
  void getLyricInfo({
    musicInfo: downloadInfo.metadata.musicInfo,
    isRefresh: false,
    allowToggleSource: appSetting['download.isUseOtherSource'],
  }).then(lrcs => {
    if (lrcs.lyric) {
      lrcs.lyric = fixKgLyric(lrcs.lyric)
      const info = {
        filePath: downloadInfo.metadata.filePath.substring(0, downloadInfo.metadata.filePath.lastIndexOf('.')) + '.lrc',
        format: appSetting['download.lrcFormat'],
        downloadLxlrc: appSetting['download.isDownloadLxLrc'],
        downloadTlrc: appSetting['download.isDownloadTLrc'],
        downloadRlrc: appSetting['download.isDownloadRLrc'],
      }
      void window.lx.worker.download.saveLrc(lrcs, info)
    }
  })
}

// 主进程账号链路错误消息带稳定前缀（见 accountSource requestUrl），据此归类错误码
const isAccountExpiredError = (err: unknown) => {
  return /^account_expired: /.test(err instanceof Error ? err.message : String(err))
}
const isRiskControlError = (err: unknown) => {
  return /^risk_control: /.test(err instanceof Error ? err.message : String(err))
}

const getUrl = async(downloadInfo: LX.Download.ListItem, isRefresh: boolean = false): Promise<{ url: string, errorCode?: LX.Download.ErrorCode, wait?: boolean, viaSpill?: boolean, memberName?: string }> => {
  // 清掉上一次解析的通道标注，避免「换链/换通道后残留旧成员名」误导徽标与下载成败记账
  downloadInfo.metadata.sourceChannel = undefined
  downloadInfo.metadata.poolMemberId = undefined
  const { musicInfo, quality } = downloadInfo.metadata
  const source = musicInfo.source
  let toggleMusicInfo = musicInfo.meta.toggleMusicInfo
  const toResult = async(promise: Promise<string>): Promise<{ url: string, errorCode?: LX.Download.ErrorCode }> => promise.then(url => ({ url }), err => {
    // 诊断日志：真机验证期观察下载取链失败原因，稳定后移除
    console.log('[download] getUrl failed:', err instanceof Error ? err.message : err)
    const errorCode = isAccountExpiredError(err) ? 'account_expired' : isRiskControlError(err) ? 'risk_control' : undefined
    return { url: '', errorCode }
  })
  // 统一供给池分发资格（ADR 0007）：存在可服务（平台×音质）的供给源。
  // 换源缓存仅对不分发的歌曲短路（issues/04：分发资格的歌曲若被此分支短路，池与账号的调度将被完全绕过）
  const dispatchEligible = await isDispatchEligible(source, quality)
  const result = toggleMusicInfo && !dispatchEligible
    ? await toResult(getMusicUrl({
      musicInfo: toggleMusicInfo,
      isRefresh,
      quality,
      allowToggleSource: false,
      noRiskControlFallback: true,
    }))
    : { url: '' }
  if (result.url) {
    logToMain(`[dispatch] ${musicInfo.name}: 换源缓存分支命中(toggle source=${toggleMusicInfo?.source})`)
    return result
  }

  // 无任何有能力的供给源（如非账号平台的高音质任务）：维持原单链（生效音源 + 可选换源），不进供给池
  if (!dispatchEligible) {
    logToMain(`[dispatch] ${musicInfo.name} ${source}/${quality}: 单链出口(无可分发供给源) status=${JSON.stringify(accountSource.status[source as LX.AccountSource.Platform] ?? null)}`)
    return toResult(getMusicUrl({
      musicInfo,
      isRefresh: false,
      quality,
      allowToggleSource: appSetting['download.isUseOtherSource'],
    }))
  }

  // 统一供给池单循环（ADR 0007）：能力→健康→在途最少（纯空闲不看身份），任一失败转移下一个供给源；
  // 账号只认冷却不记连败（buildAccountApi 内含「账号失败落生效音源」内联兜底，0005 延续），
  // 脚本走（成员×平台）熔断；下载层成败经 metadata.poolMemberId 回灌（issue source-pool/01）
  let errorCode: LX.Download.ErrorCode | undefined
  let sawRiskControl = false
  const triedProviderIds: string[] = []
  while (triedProviderIds.length < DISPATCH_BUDGET) {
    const provider = await pickProvider(source, quality, triedProviderIds)
    if (!provider) break
    triedProviderIds.push(provider.id)
    logToMain(`[dispatch] ${musicInfo.name} ${source}/${quality}: try ${provider.kind}:${provider.name} (${triedProviderIds.length}/${DISPATCH_BUDGET})`)
    const r = await toResult(resolveViaProvider(provider, musicInfo, quality, isRefresh))
    if (r.url) {
      if (provider.kind == 'account') {
        downloadInfo.metadata.sourceChannel = 'account'
        return { url: r.url }
      }
      // 野花沿用旧标识，兼容已持久化任务的徽标（download_list.d.ts sourceChannel）
      downloadInfo.metadata.sourceChannel = provider.id == SPILL_API_ID ? 'yehua' : provider.name
      // 记录成员 id：下载成败回灌该成员的熔断记账（issue source-pool/01）
      downloadInfo.metadata.poolMemberId = provider.id
      return { url: r.url, viaSpill: true, memberName: provider.name }
    }
    errorCode = r.errorCode ?? errorCode
    if (r.errorCode == 'risk_control') sawRiskControl = true
  }
  if (triedProviderIds.length == 0) {
    // 全部供给源都在恢复期：回等待，恢复点自动唤醒（不进兜底链）
    logToMain(`[dispatch] ${musicInfo.name} ${source}/${quality}: 供给源全恢复期回等待`)
    return { url: '', errorCode, wait: earliestRecovery(source, quality) > 0 }
  }

  // 兜底链（生效音源）：风控错误不回落（冷却可恢复，回等待重试）；生效音源已在池里试过时跳过
  if (!sawRiskControl && apiSource.value != null && !triedProviderIds.includes(apiSource.value)) {
    const fallbackApi = getFallbackApi(source)
    if (fallbackApi?.getMusicUrl) {
      const fallbackResult = await toResult(fallbackApi.getMusicUrl(toOldMusicInfo(musicInfo), quality).promise)
      if (fallbackResult.url) return fallbackResult
      errorCode = fallbackResult.errorCode ?? errorCode
    }
  }

  // 开启「下载失败换源」时的最后手段：允许换其他音乐源搜索同名歌
  if (!sawRiskControl && appSetting['download.isUseOtherSource']) {
    const toggleResult = await toResult(getMusicUrl({
      musicInfo,
      isRefresh: false,
      quality,
      allowToggleSource: true,
    }))
    if (toggleResult.url) return toggleResult
    errorCode = toggleResult.errorCode ?? errorCode
  }

  // 有供给源仍在恢复期（账号冷却/脚本熔断）→ 回等待而不是报错
  return { url: '', errorCode, wait: earliestRecovery(source, quality) > 0 }
}
const handleRefreshUrl = (downloadInfo: LX.Download.ListItem) => {
  setStatusText(downloadInfo, window.i18n.t('download_status_error_refresh_url'))
  // 换链走完整分发器（ADR 0005/0006/0007）：refreshUrl 的链接同样经统一供给池分发与兜底链，
  // 不再直连生效音源（分发器入口会清旧通道标注，换到谁记账记到谁）
  void getUrl(downloadInfo, true).then(urlResult => {
    if (!urlResult.url) {
      // 全部供给源在恢复期：退回等待恢复点重解析，而不是把任务置错（与初始分发一致）
      if (urlResult.wait) {
        setUrl(downloadInfo, '') // 清掉死链：唤醒重启后 metadata.url 为空，重新走分发器取新链
        backToChannelWait(downloadInfo, urlResult.errorCode)
        return
      }
      handleError(downloadInfo, window.i18n.t('download_status_error_url_failed'), urlResult.errorCode ?? 'url_failed')
      return
    }
    setUrl(downloadInfo, urlResult.url)
    void window.lx.worker.download.updateUrl(downloadInfo.id, urlResult.url)
  }).catch(err => {
    console.log(err)
    handleError(downloadInfo, err.message, 'url_failed')
  })
}
// i18n key → 结构化错误码（开放 API /download-status 的 errorCode 字段）
const ERROR_CODE_MAP: Record<string, LX.Download.ErrorCode> = {
  download_status_error_url_failed: 'url_failed',
  download_status_error_check_path_exist: 'file_exists',
  download_status_error_check_path: 'check_path',
  download_status_error_response: 'response',
  download_status_error_write: 'write',
  download_status_error_stalled: 'stalled',
}
const toErrorCode = (i18nKey?: string): LX.Download.ErrorCode => ERROR_CODE_MAP[i18nKey ?? ''] ?? 'unknown'

const handleError = (downloadInfo: LX.Download.ListItem, message?: string, errorCode: LX.Download.ErrorCode = 'unknown') => {
  downloadInfo.errorCode = errorCode
  setStatus(downloadInfo, DOWNLOAD_STATUS.ERROR, message)
  void window.lx.worker.download.removeTask(downloadInfo.id)
  runingTask.delete(downloadInfo.id)
  void checkStartTask()
}

// 供给源全恢复期：任务退回等待队列并设退避，恢复点由冷却 watcher/熔断定时器唤醒；
// 反复恢复失败的任务按轮数上限报错，避免注定失败的歌无限空转（初始分发与换链共用）
const backToChannelWait = (downloadInfo: LX.Download.ListItem, errorCode?: LX.Download.ErrorCode) => {
  runingTask.delete(downloadInfo.id)
  const waitCount = (channelWaitCount.get(downloadInfo.id) ?? 0) + 1
  if (waitCount > CHANNEL_WAIT_MAX) {
    channelWaitCount.delete(downloadInfo.id)
    handleError(downloadInfo, window.i18n.t('download_status_channel_wait_timeout'), errorCode ?? 'unknown')
    return
  }
  channelWaitCount.set(downloadInfo.id, waitCount)
  setStatus(downloadInfo, DOWNLOAD_STATUS.WAITING)
  markChannelWaiting(downloadInfo)
  // 供给池统一恢复点（ADR 0007）：按任务平台与音质过滤可服务的供给源，取最早恢复时间
  const waitSource = downloadInfo.metadata.musicInfo.source
  const recoveryAt = earliestRecovery(waitSource, downloadInfo.metadata.quality)
  channelWaitRetryAt.set(downloadInfo.id, recoveryAt + 1000)
  if (recoveryAt > Date.now()) setTimeout(() => { void checkStartTask() }, recoveryAt - Date.now() + 1000)
  void checkStartTask()
}

const handleStartTask = async(downloadInfo: LX.Download.ListItem) => {
  console.log('[download] handleStartTask:', downloadInfo.metadata.musicInfo.name, 'metaUrl=', JSON.stringify(downloadInfo.metadata.url ?? null), 'quality=', downloadInfo.metadata.quality)
  let viaThirdParty = false
  let thirdPartyMemberName = ''
  if (!downloadInfo.metadata.url) {
    setStatusText(downloadInfo, window.i18n.t('download_status_url_getting'))
    const urlResult = await getUrl(downloadInfo)
    console.log('[download] urlResult:', urlResult.url ? 'got url' : 'EMPTY', urlResult.errorCode ?? '', urlResult.url ?? '')
    if (!urlResult.url) {
      // 通道暂不可用（账号冷却/供给源熔断）：退回等待队列，恢复点自动唤醒
      if (urlResult.wait) {
        backToChannelWait(downloadInfo, urlResult.errorCode)
        return
      }
      handleError(downloadInfo, window.i18n.t('download_status_error_url_failed'), urlResult.errorCode ?? 'url_failed')
      return
    }
    viaThirdParty = urlResult.viaSpill ?? false
    thirdPartyMemberName = urlResult.memberName ?? ''
    setUrl(downloadInfo, urlResult.url)
    if (downloadInfo.status != DOWNLOAD_STATUS.RUN) return
  }

  const savePath = buildSavePath(downloadInfo)
  const filePath = joinPath(savePath, downloadInfo.metadata.fileName)
  if (downloadInfo.metadata.filePath != filePath) updateFilePath(downloadInfo, filePath)

  setStatusText(downloadInfo, window.i18n.t('download_status_start'))

  await window.lx.worker.download.startTask(toRaw(downloadInfo), savePath, appSetting['download.skipExistFile'], proxyCallback((event: LX.Download.DownloadTaskActions) => {
    // console.log(event)
    switch (event.action) {
      case 'start':
        setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
        // 三方通道标记在 start 之后写，避免被「开始下载」文案同帧覆盖
        if (viaThirdParty) setStatusText(downloadInfo, window.i18n.t('download_status_via_third_party', { name: thirdPartyMemberName }))
        break
      case 'complete':
        // 直链下载成功：该成员链接确实可用，熔断计数归零（issue source-pool/01）
        if (downloadInfo.metadata.poolMemberId) poolMemberReportDownload(downloadInfo.metadata.poolMemberId, downloadInfo.metadata.musicInfo.source, true)
        downloadInfo.progress = 100
        saveMeta(downloadInfo)
        downloadLyric(downloadInfo)
        void window.lx.worker.download.removeTask(downloadInfo.id)
        runingTask.delete(downloadInfo.id)
        setStatus(downloadInfo, DOWNLOAD_STATUS.COMPLETED)
        void checkStartTask()
        break
      case 'refreshUrl':
        // 换链前记账：本次下载失败归咎当前出链成员（issue source-pool/02），
        // 否则死链成员靠 refreshUrl 救活永远不积累熔断计数；handleRefreshUrl 重新分发后重归因
        if (downloadInfo.metadata.poolMemberId) poolMemberReportDownload(downloadInfo.metadata.poolMemberId, downloadInfo.metadata.musicInfo.source, false)
        handleRefreshUrl(downloadInfo)
        break
      case 'statusText':
        setStatusText(downloadInfo, event.data)
        break
      case 'statusTextKey':
        setStatusText(downloadInfo, window.i18n.t(event.data.key, event.data.params))
        break
      case 'progress':
        setProgress(downloadInfo, event.data)
        break
      case 'error':
        // 下载层失败回灌池成员熔断（issue source-pool/01）：仅记到出链接的成员头上（按任务平台记账），
        // 写盘/路径类本地故障不记账；账号/兜底链的链接 poolMemberId 为空不记
        if (downloadInfo.metadata.poolMemberId &&
          !['download_status_error_write', 'download_status_error_check_path', 'download_status_error_check_path_exist'].includes(event.data.error ?? '')) {
          poolMemberReportDownload(downloadInfo.metadata.poolMemberId, downloadInfo.metadata.musicInfo.source, false)
        }
        handleError(downloadInfo, event.data.error
          ? window.i18n.t(event.data.error) + (event.data.message ?? '')
          : event.data.message,
        toErrorCode(event.data.error),
        )
        break
      default:
        break
    }
  }), getProxy())
}
const startTask = async(downloadInfo: LX.Download.ListItem) => {
  channelWaitCount.delete(downloadInfo.id)
  setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
  runingTask.set(downloadInfo.id, downloadInfo)
  void handleStartTask(downloadInfo)
}

// 账号音源生效/冷却判定在 providerPool（统一供给池的健康语义）；此处任务调度沿用同一判定：
// 冷却中 128k 任务放行（分发器借脚本供给源继续），flac/320k 等账号恢复
const canStartByCooldown = (downloadInfo: LX.Download.ListItem) => {
  const source = downloadInfo.metadata.musicInfo.source
  if (!isAccountSourceActive(source)) return true
  if (!isPlatformCoolingDown(source)) return true
  // 冷却中：128k 任务放行（分发器借脚本供给源继续），flac/320k 等账号恢复
  return downloadInfo.metadata.quality == '128k'
}

// 等待通道恢复的任务停在等待队列：冷却显示剩余分钟，三方熔断显示稍后重试（文案变化才落盘）
const markChannelWaiting = (downloadInfo: LX.Download.ListItem) => {
  const source = downloadInfo.metadata.musicInfo.source
  const text = isPlatformCoolingDown(source)
    ? window.i18n.t('download_status_risk_control_cooldown', { num: Math.max(1, Math.ceil(((accountSource.status[source as LX.AccountSource.Platform]?.cooldownUntil ?? 0) - Date.now()) / 60000)) })
    : window.i18n.t('download_status_spill_broken')
  if (downloadInfo.statusText != text) setStatusText(downloadInfo, text)
}

const getStartTask = (list: LX.Download.ListItem[]): LX.Download.ListItem | null => {
  let downloadCount = 0
  // 当前音源是用户音源且脚本未就绪时，排队任务一律挂起，避免启动即失败
  const sourceNotReady = apiSource.value?.startsWith('user_api') == true && userApi.status !== true
  const waitList = list.filter(item => {
    if (item.status == DOWNLOAD_STATUS.WAITING) {
      if (sourceNotReady) return false
      // 恢复期退避：未到重试时间的任务不重选（唤醒交给冷却 watcher 与熔断定时器）
      const retryAt = channelWaitRetryAt.get(item.id)
      if (retryAt != null) {
        if (retryAt > Date.now()) return false
        channelWaitRetryAt.delete(item.id)
      }
      // 任务钉住的音源与当前不一致时挂起等待，避免切源后排队的任务拿错音源解析
      const pinned = item.metadata.apiSource
      if (pinned && pinned != apiSource.value && userApi.list.some(api => api.id == pinned)) return false
      if (!canStartByCooldown(item)) {
        markChannelWaiting(item)
        return false
      }
      return true
    }
    if (item.status == DOWNLOAD_STATUS.RUN) ++downloadCount
    return false
  })
  // console.log(downloadCount, waitList)
  return downloadCount < appSetting['download.maxDownloadNum'] ? waitList.shift() ?? null : null
}

const checkStartTask = async() => {
  if (runingTask.size >= appSetting['download.maxDownloadNum']) return
  let result = getStartTask(downloadList)
  // console.log(result)
  while (result) {
    await startTask(result)
    result = getStartTask(downloadList)
  }
}

/**
 * 过滤重复任务
 *
 * 判重语义（camel 035）：等待/运行/暂停的在途条目维持判重（静默丢弃同 id 新任务）；
 * 失败/已完成的终态条目被同 id 新提交命中时移除旧条目、放行新任务——重新下载 = 重试
 * @param list
 */
const filterTask = async(list: LX.Download.ListItem[]) => {
  const set = new Set<string>()
  const terminal = new Map<string, LX.Download.ListItem>()
  for (const item of downloadList) {
    set.add(item.id)
    if (item.status == DOWNLOAD_STATUS.ERROR || item.status == DOWNLOAD_STATUS.COMPLETED) terminal.set(item.id, item)
  }
  const admitted: LX.Download.ListItem[] = []
  const staleIds = new Set<string>()
  for (const item of list) {
    if (set.has(item.id)) {
      // 同 id 命中终态条目：标记替换（批内重复 id 只有第一个生效）
      if (terminal.has(item.id) && !staleIds.has(item.id)) {
        staleIds.add(item.id)
        markRaw(item.metadata)
        admitted.push(item)
      }
      continue
    }
    markRaw(item.metadata)
    set.add(item.id)
    admitted.push(item)
  }
  if (staleIds.size) await removeDownloadTasks([...staleIds])
  return admitted
}
// 音源切换或脚本就绪状态变化后重新调度：切回时自动恢复被钉源挂起的任务
watch([apiSource, () => userApi.status], () => { void checkStartTask() })

// 风控冷却结束自动恢复同平台排队任务：收到带新 cooldownUntil 的状态广播时重设定时器
const cooldownTimers: Partial<Record<LX.AccountSource.Platform, ReturnType<typeof setTimeout>>> = {}
watch(() => accountSource.status, () => {
  for (const platform of ['kg', 'tx', 'wy'] as const) {
    const wait = (accountSource.status[platform]?.cooldownUntil ?? 0) - Date.now()
    if (wait <= 0) continue
    clearTimeout(cooldownTimers[platform])
    cooldownTimers[platform] = setTimeout(() => { void checkStartTask() }, wait + 1000)
  }
}, { immediate: true })

/**
 * 创建下载任务
 * @param list 要下载的歌曲
 * @param quality 下载音质
 * @param savePath 可选的逐任务保存目录，缺省用全局下载目录设置
 */
export const createDownloadTasks = async(list: LX.Music.MusicInfoOnline[], quality: LX.Quality, listId?: string, savePath?: string) => {
  if (!list.length) return
  const tasks = await filterTask(await window.lx.worker.download.createDownloadTasks(list, quality,
    appSetting['download.fileName'],
    toRaw(qualityList.value), listId),
  )
  // 钉住创建时的音源，调度器据此决定何时启动该任务
  const currentApiSource = apiSource.value
  for (const task of tasks) {
    if (savePath) task.metadata.savePath = savePath
    task.metadata.apiSource = currentApiSource ?? undefined
  }

  if (tasks.length) await addTasks(tasks)
  void checkStartTask()
}

/**
 * 开始下载任务
 * @param list
 */
export const startDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.PAUSE:
      case DOWNLOAD_STATUS.ERROR:
        // 复用账号音源冷却判定，避免恢复任务直启绕过调度器
        if (runingTask.size < appSetting['download.maxDownloadNum'] && canStartByCooldown(downloadInfo)) void startTask(downloadInfo)
        else setStatus(downloadInfo, DOWNLOAD_STATUS.WAITING)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 暂停下载任务
 * @param list
 */
export const pauseDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.RUN:
        void window.lx.worker.download.pauseTask(downloadInfo.id)
        runingTask.delete(downloadInfo.id)
      case DOWNLOAD_STATUS.WAITING:
      case DOWNLOAD_STATUS.ERROR:
        setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 移除下载任务
 * @param ids 要移除的任务Id
 */
export const removeDownloadTasks = async(ids: string[]) => {
  await downloadTasksRemove(ids)

  const idsSet = new Set<string>(ids)
  const newList = downloadList.filter(task => {
    if (runingTask.has(task.id)) {
      void window.lx.worker.download.removeTask(task.id)
      runingTask.delete(task.id)
    }
    channelWaitRetryAt.delete(task.id)
    channelWaitCount.delete(task.id)
    return !idsSet.has(task.id)
  })
  downloadList.splice(0, downloadList.length)
  arrPush(downloadList, newList)


  void checkStartTask()
  window.app_event.downloadListUpdate()
}
