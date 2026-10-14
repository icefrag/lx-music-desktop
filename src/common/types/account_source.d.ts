declare namespace LX {
  namespace AccountSource {
    type Platform = 'kg' | 'tx' | 'wy'
    type StatusType = 'ok' | 'expired' | 'unknown'

    interface Status {
      /** 分区里是否存有登录 cookie */
      login: boolean
      /** ok: 校验/取链通过；expired: 服务端判定凭证失效；unknown: 尚未校验 */
      status: StatusType
      nickname?: string
      message?: string
      updatedAt: number
      /** 风控冷却截止时间戳（毫秒）；缺省或已过期 = 未冷却 */
      cooldownUntil?: number
    }

    type StatusMap = Record<Platform, Status>

    interface UrlRequestParams {
      source: Platform
      type: LX.Quality
      /** toOldMusicInfo 之后的扁平歌曲信息；各平台消费字段不同（kg 用 hash/albumAudioId 等），暂用宽松结构 */
      musicInfo: Record<string, any>
      /** 三方通道池成员 id（ADR 0006）：渲染层分发器选中的成员，主进程据此路由到对应沙箱 */
      memberId: string
    }

    interface UrlResult {
      url: string
    }

    /** 三方通道池成员能力上报（沙箱 init 成功后由主进程广播） */
    interface PoolMemberInfo {
      id: string
      name: string
      sources: Record<string, { actions: string[], qualitys: string[] }>
    }
  }
}
