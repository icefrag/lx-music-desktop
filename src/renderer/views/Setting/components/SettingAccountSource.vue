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
    .p.small.gap-top {{ $t('account_source__expired_tip') }}
</template>

<script>
import { computed, ref } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { accountSource } from '@renderer/store'
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

    return {
      platforms,
      status,
      loggingIn,
      statusText,
      statusNickname,
      loginLabel,
      handleLogin,
      handleLogout,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.btn {
  margin-left: 10px;
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
