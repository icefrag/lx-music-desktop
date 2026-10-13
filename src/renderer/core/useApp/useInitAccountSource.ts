// ts-loader 按依赖图构建编译程序，全局声明文件需显式引用才能并入
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../common/types/account_source.d.ts" />
import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { getAccountSourceStatus, onAccountSourceStatus } from '@renderer/utils/ipc'
import { accountSource, qualityList, setQualityList } from '@renderer/store'
import { dialog } from '@renderer/plugins/Dialog'

const ACCOUNT_QUALITYS: LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit']

// 各平台登录前的档位快照，登出/过期后还原
const originalQualitys: Partial<Record<LX.AccountSource.Platform, LX.Quality[]>> = {}

// 账号音源可用的平台在原有档位基础上放开全部音质（当前音源可能只声明了 128k）
const overrideQualityList = () => {
  const qualitys: LX.QualityList = { ...qualityList.value }
  let changed = false
  for (const [platform, status] of Object.entries(accountSource.status) as Array<[LX.AccountSource.Platform, LX.AccountSource.Status]>) {
    if (!status.login || status.status == 'expired') {
      const original = originalQualitys[platform]
      if (original && JSON.stringify(qualitys[platform]) != JSON.stringify(original)) {
        qualitys[platform] = [...original]
        changed = true
      }
      continue
    }
    // 与登录前档位取并集，避免挤掉当前音源声明的其他格式
    const merged = [...new Set([...(qualitys[platform] ?? []), ...ACCOUNT_QUALITYS])]
    if (JSON.stringify(qualitys[platform]) != JSON.stringify(merged)) {
      if (!originalQualitys[platform]) originalQualitys[platform] = [...(qualitys[platform] ?? [])]
      qualitys[platform] = merged
      changed = true
    }
  }
  if (changed) setQualityList(qualitys)
}

export default () => {
  const t = useI18n()

  const rStatus = onAccountSourceStatus(({ params: status }) => {
    for (const [platform, newStatus] of Object.entries(status) as Array<[LX.AccountSource.Platform, LX.AccountSource.Status]>) {
      const prev = accountSource.status[platform]
      if (newStatus.status == 'expired' && prev.status != 'expired' && prev.login) {
        void dialog({
          message: t('account_source__expired_alert', { name: t(`account_source__platform_${platform}`) }),
          selection: true,
          confirmButtonText: t('ok'),
        })
      }
    }
    accountSource.status = status
    overrideQualityList()
  })

  watch(qualityList, () => {
    overrideQualityList()
  })

  void getAccountSourceStatus().then(status => {
    accountSource.status = status
    overrideQualityList()
  }).catch(err => {
    console.log(err)
  })

  onBeforeUnmount(() => {
    rStatus()
  })
}
