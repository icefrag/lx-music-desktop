import { onBeforeUnmount } from '@common/utils/vueTools'
import { onOpenApiSonglistRequest, sendOpenApiSonglistResponse } from '@renderer/utils/ipc'
import { getListDetail, getListDetailAll } from '@renderer/store/songList/action'
import musicSdk from '@renderer/utils/musicSdk'


/**
 * 响应主进程开放 API 的在线歌单数据请求（requestKey 往返，见 ADR-0001）
 */
export default () => {
  const rOnRequest = onOpenApiSonglistRequest(async({ params: { requestKey, source, id } }) => {
    try {
      if (!musicSdk[source as LX.OnlineSource]?.songList) throw new Error('Source no match')
      const detail = await getListDetail(id, source as LX.OnlineSource, 1)
      const list = await getListDetailAll(id, source as LX.OnlineSource)
      sendOpenApiSonglistResponse({
        requestKey,
        data: {
          source,
          id,
          info: detail.info as unknown as Record<string, unknown>,
          total: detail.total,
          limit: detail.limit,
          // 平铺 songmid 作为下载端点的筛选契约字段
          list: list.map(m => ({ ...m, songmid: m.meta.songId })),
        },
      })
    } catch (err: any) {
      sendOpenApiSonglistResponse({ requestKey, error: err.message })
    }
  })

  onBeforeUnmount(() => {
    rOnRequest()
  })
}
