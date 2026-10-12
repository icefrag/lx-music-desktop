import { useRouter, useRoute } from '@common/utils/vueRouter'
import { isShowPlayerDetail } from '@renderer/store/player/state'
import { setShowPlayerDetail } from '@renderer/store/player/action'
import usePlaySonglist from '../compositions/usePlaySonglist'
import { focusWindow } from '@renderer/utils/ipc'
import { getListDetailAll } from '@renderer/store/songList/action'
import { createDownloadTasks } from '@renderer/store/download/action'

import { dataVerify, qualitys, sourceVerify } from './utils'

const useOpenSonglist = () => {
  const router = useRouter()
  const route = useRoute()

  const handleOpenSonglist = params => {
    if (params.id) {
      router[route.path == '/songList/detail' ? 'replace' : 'push']({
        path: '/songList/detail',
        query: {
          source: params.source,
          id: params.id,
        },
      })
    } else if (params.url) {
      router[route.path == '/songList/detail' ? 'replace' : 'push']({
        path: '/songList/detail',
        query: {
          source: params.source,
          id: params.url,
        },
      })
    }
  }

  return ({ paths, data }) => {
    let songlistInfo = {
      source: null,
      id: null,
      url: null,
    }
    if (data) {
      songlistInfo = data
    } else {
      songlistInfo.source = paths[0]
      songlistInfo.url = paths[1]
    }

    sourceVerify(songlistInfo.source)

    songlistInfo = dataVerify([
      { key: 'source', types: ['string'] },
      { key: 'id', types: ['string', 'number'], max: 64 },
      { key: 'url', types: ['string'], max: 500 },
    ], songlistInfo)

    if (!songlistInfo.id && !songlistInfo.url) throw new Error('id or url missing')
    if (isShowPlayerDetail.value) setShowPlayerDetail(false)
    handleOpenSonglist(songlistInfo)
    focusWindow()
  }
}
const usePlaySonglistDetail = () => {
  const playSongListDetail = usePlaySonglist()

  return async({ paths, data }) => {
    let songlistInfo = {
      source: null,
      id: null,
      url: null,
      index: null,
    }
    if (data) {
      songlistInfo = data
    } else {
      songlistInfo.source = paths[0]
      songlistInfo.url = paths[1]
      songlistInfo.index = paths[2]
      if (songlistInfo.index != null) {
        songlistInfo.index = parseInt(songlistInfo.index)
        if (Number.isNaN(songlistInfo.index)) delete songlistInfo.index
      }
    }

    sourceVerify(songlistInfo.source)

    songlistInfo = dataVerify([
      { key: 'source', types: ['string'] },
      { key: 'id', types: ['string', 'number'], max: 64 },
      { key: 'url', types: ['string'], max: 500 },
      { key: 'index', types: ['number'], max: 1000000 },
    ], songlistInfo)

    if (!songlistInfo.id && !songlistInfo.url) throw new Error('id or url missing')

    await playSongListDetail(songlistInfo.source, songlistInfo.id ?? songlistInfo.url, songlistInfo.index)
  }
}

const useDownloadSonglist = () => {
  return async({ data }) => {
    const info = dataVerify([
      { key: 'source', types: ['string'], required: true },
      { key: 'id', types: ['string', 'number'], required: true, max: 500 },
      { key: 'quality', types: ['string'], max: 10 },
      { key: 'songmids', types: ['object'] },
      { key: 'limit', types: ['number'] },
      { key: 'dir', types: ['string'], max: 500 },
    ], data)

    sourceVerify(info.source)

    const quality = qualitys.includes(info.quality) ? info.quality : '320k'
    let list = await getListDetailAll(String(info.id), info.source)
    if (info.songmids?.length) {
      // 按调用方提供的曲目唯一 id 精确筛选，未命中的忽略
      const idSet = new Set(info.songmids.map(m => String(m)))
      list = list.filter(m => idSet.has(String(m.meta.songId)))
    } else if (info.limit > 0) {
      list = list.slice(0, info.limit)
    }
    if (list.length) await createDownloadTasks(list, quality, undefined, info.dir)
    focusWindow()
  }
}

export default () => {
  const handleOpenSonglist = useOpenSonglist()
  const handlePlaySonglist = usePlaySonglistDetail()
  const handleDownloadSonglist = useDownloadSonglist()


  return async(action, info) => {
    switch (action) {
      case 'open':
        handleOpenSonglist(info)
        break
      case 'play':
        await handlePlaySonglist(info)
        break
      case 'download':
        await handleDownloadSonglist(info)
        break
      default: throw new Error('Unknown action: ' + action)
    }
  }
}
