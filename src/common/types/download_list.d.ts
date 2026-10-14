import { type Message } from '@root/lang'

// interface DownloadList {

// }


declare global {
  namespace LX {
    namespace Download {
      type DownloadTaskStatus = 'run'
      | 'waiting'
      | 'pause'
      | 'error'
      | 'completed'

      type FileExt = 'mp3' | 'flac' | 'wav' | 'ape'

      type ErrorCode = 'url_failed'
      | 'account_expired'
      | 'risk_control'
      | 'file_exists'
      | 'check_path'
      | 'response'
      | 'write'
      | 'unknown'

      interface ProgressInfo {
        progress: number
        speed: string
        downloaded: number
        total: number
        writeQueue: number
      }

      interface DownloadTaskActionBase <A> {
        action: A
      }
      interface DownloadTaskActionData<A, D> extends DownloadTaskActionBase<A> {
        data: D
      }
      type DownloadTaskAction<A, D = undefined> = D extends undefined ? DownloadTaskActionBase<A> : DownloadTaskActionData<A, D>

      type DownloadTaskActions = DownloadTaskAction<'start'>
      | DownloadTaskAction<'complete'>
      | DownloadTaskAction<'refreshUrl'>
      | DownloadTaskAction<'statusText', string>
      | DownloadTaskAction<'progress', ProgressInfo>
      | DownloadTaskAction<'error', {
        error?: keyof Message
        message?: string
      }>

      interface ListItem {
        id: string
        isComplate: boolean
        status: DownloadTaskStatus
        statusText: string
        errorCode?: ErrorCode
        downloaded: number
        total: number
        progress: number
        speed: string
        writeQueue: number
        metadata: {
          musicInfo: LX.Music.MusicInfoOnline
          url: string | null
          quality: LX.Quality
          ext: FileExt
          fileName: string
          filePath: string
          savePath?: string
          apiSource?: string
          /** 解析通道：account=账号音源，yehua=三方通道（内置野花）；缺省=非双通道路径 */
          sourceChannel?: string
          listId?: string
        }
      }

      interface saveDownloadMusicInfo {
        list: ListItem[]
        addMusicLocationType: LX.AddMusicLocationType
      }
    }
  }
}
