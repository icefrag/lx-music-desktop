import * as kg from './kg'
import * as tx from './tx'
import * as wy from './wy'

export interface PlatformResolver {
  validate: () => Promise<{ ok: boolean, nickname?: string }>
  // songInfo 是 toOldMusicInfo 之后的扁平歌曲信息，各平台消费的字段不同，无法收敛为固定类型
  getMusicUrl: (songInfo: Record<string, any>, quality: LX.Quality) => Promise<string>
}

export const resolvers: Record<LX.AccountSource.Platform, PlatformResolver> = {
  wy,
  tx,
  kg,
}
