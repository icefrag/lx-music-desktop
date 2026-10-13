<template lang="pug">
dt#account_source {{ $t('setting__account_source') }}
dd.gap-top
  div
    .p.small {{ $t('account_source__tip') }}
    .p.gap-top(v-for="platform in platforms" :key="platform.id")
      strong {{ $t(`account_source__platform_${platform.id}`) }}
      span(:class="$style.status" :class-status="statusText(platform).type") {{ statusText(platform).label }}
      span.small(v-if="statusNickname(platform)") （{{ statusNickname(platform) }}）
      base-btn.btn.min(:class="$style.btn" :disabled="loggingIn != null" @click="handleLogin(platform.id)") {{ loginLabel(platform) }}
      base-btn.btn.min(v-if="status[platform.id].login" :class="$style.btn" :disabled="loggingIn != null" @click="handleLogout(platform.id)") {{ $t('account_source__logout') }}
    .p.small.gap-top {{ $t('account_source__request_interval_tip') }}
    div(:class="$style.intervalRow")
      span.small {{ $t('account_source__request_interval') }}
      template(v-for="platform in platforms" :key="platform.id")
        span.small {{ $t(`account_source__platform_${platform.id}`) }}
        base-input(:class="$style.intervalInput" :model-value="appSetting[`accountSource.requestInterval.${platform.id}`]" type="number" :aria-label="$t(`account_source__platform_${platform.id}`) + ' ' + $t('account_source__request_interval')" @update:model-value="handleSetInterval(platform.id, $event)")
    .p.small.gap-top {{ $t('account_source__expired_tip') }}
</template>

<script>
import { computed, ref } from '@common/utils/vueTools'
import { debounce } from '@common/utils'
import { useI18n } from '@renderer/plugins/i18n'
import { accountSource } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { loginAccountSource, logoutAccountSource } from '@renderer/utils/ipc'
import { dialog } from '@renderer/plugins/Dialog'

export default {
  name: 'SettingAccountSource',
  setup() {
    const t = useI18n()
    const loggingIn = ref(null)

    const platforms = [
      { id: 'wy' },
      { id: 'tx' },
      { id: 'kg' },
    ]

    const statusText = ({ id }) => {
      const status = accountSource.status[id]
      if (!status?.login) return { type: 'none', label: t('account_source__status_none') }
      switch (status.status) {
        case 'ok':
          return { type: 'ok', label: t('account_source__status_ok') }
        case 'expired':
          return { type: 'expired', label: t('account_source__status_expired') }
        default:
          return { type: 'unknown', label: t('account_source__status_unknown') }
      }
    }
    const statusNickname = ({ id }) => accountSource.status[id]?.nickname

    const loginLabel = ({ id }) => {
      if (loggingIn.value == id) return t('account_source__logging_in')
      return accountSource.status[id]?.login ? t('account_source__relogin') : t('account_source__login')
    }

    const handleLogin = async(id) => {
      loggingIn.value = id
      try {
        await loginAccountSource(id)
      } catch (err) {
        if (!/已取消|已关闭/.test(err.message)) {
          void dialog({
            message: `${t('account_source__login_failed')}\n${err.message}`,
            selection: true,
            confirmButtonText: t('ok'),
          })
        }
      } finally {
        loggingIn.value = null
      }
    }

    const handleLogout = async(id) => {
      try {
        await logoutAccountSource(id)
      } catch (err) {
        void dialog({
          message: `${t('account_source__logout_failed')}\n${err.message}`,
          selection: true,
          confirmButtonText: t('ok'),
        })
      }
    }

    // 状态对象在 useInitAccountSource 里是整体替换，必须用 computed 才能跟随更新
    const status = computed(() => accountSource.status)

    // 每个平台独立的防抖 setter：共享单个 debounce 实例会丢掉前一个字段未提交的编辑
    const intervalSetters = new Map()
    const handleSetInterval = (platform, value) => {
      const seconds = Number(value)
      // 空值/非法输入保持原设置，避免误清空触发「0 = 不限速」
      if (!Number.isFinite(seconds) || seconds < 0) return
      if (!intervalSetters.has(platform)) {
        intervalSetters.set(platform, debounce(val => {
          updateSetting({ [`accountSource.requestInterval.${platform}`]: Math.max(0, Math.round(val)) })
        }, 500))
      }
      intervalSetters.get(platform)(seconds)
    }

    return {
      platforms,
      status,
      loggingIn,
      statusText,
      statusNickname,
      loginLabel,
      handleLogin,
      handleLogout,
      appSetting,
      handleSetInterval,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.btn {
  margin-left: 10px;
}
.intervalRow {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.intervalInput {
  width: 90px;
}
.status {
  margin-left: 10px;
  font-size: 12px;
  &[class-status='ok'] {
    color: var(--color-success);
  }
  &[class-status='expired'] {
    color: var(--color-danger);
  }
  &[class-status='unknown'] {
    color: var(--color-font-label);
  }
}
</style>
