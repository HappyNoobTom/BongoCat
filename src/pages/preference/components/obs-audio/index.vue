<script setup lang="ts">
import { emitTo } from '@tauri-apps/api/event'
import { useNow } from '@vueuse/core'
import { Alert, Button, Flex, Input, InputNumber, Select, Slider, SpaceAddon, SpaceCompact, Switch, Tag } from 'antdv-next'
import { computed } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useObsAudioSettingsSync } from '@/composables/useObsAudio'
import { LISTEN_KEY } from '@/constants'
import { useObsAudioStore } from '@/stores/obsAudio'

const store = useObsAudioStore()
useObsAudioSettingsSync()
const now = useNow({ interval: 100 })

const inputOptions = computed(() => store.inputs.map(input => ({
  value: input.inputName,
  label: input.inputKind ? `${input.inputName}（${input.inputKind}）` : input.inputName,
})))

const statusColor = computed(() => {
  switch (store.status) {
    case 'connected':
      return 'success'
    case 'connecting':
      return 'processing'
    case 'error':
      return 'error'
    default:
      return 'default'
  }
})

const statusLabel = computed(() => {
  switch (store.status) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'error':
      return '连接失败'
    default:
      return '未连接'
  }
})

const levelWidth = computed(() => `${Math.round(store.normalizedLevel * 100)}%`)
const beatActive = computed(() => now.value - store.lastBeatAt < 240)
const beatLabel = computed(() => {
  switch (store.lastBeatIntensity) {
    case 'strong':
      return '双手重拍'
    case 'normal':
      return '普通重音'
    case 'light':
      return '轻拍'
    default:
      return '等待律动'
  }
})

type TestAction = 'left' | 'right' | 'both'

function testAction(action: TestAction) {
  void emitTo('main', LISTEN_KEY.OBS_AUDIO_TEST_ACTION, action).catch(() => {})
}

function resetDefaults() {
  store.resetSettings()
}
</script>

<template>
  <ProList title="OBS 音乐律动">
    <ProListItem
      description="开启后，BongoCat 会根据 OBS 选定音频源的重音自动敲击默认键盘。"
      title="启用音乐模式"
    >
      <Switch v-model:checked="store.settings.enabled" />
    </ProListItem>

    <ProListItem
      description="连接失败时会自动重试；密码只保存在本机配置中。"
      title="OBS 状态"
    >
      <Flex
        align="center"
        gap="small"
      >
        <Tag :color="statusColor">
          {{ statusLabel }}
        </Tag>
        <span
          v-if="store.statusMessage"
          class="color-text-tertiary text-xs"
        >
          {{ store.statusMessage }}
        </span>
      </Flex>
    </ProListItem>

    <ProListItem title="OBS 地址">
      <SpaceCompact>
        <Input
          v-model:value="store.settings.host"
          class="w-36"
          placeholder="127.0.0.1"
        />
        <SpaceAddon>:</SpaceAddon>
        <InputNumber
          v-model:value="store.settings.port"
          class="w-22"
          :max="65535"
          :min="1"
        />
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="在 OBS 的工具 → WebSocket 服务器设置中查看。"
      title="WebSocket 密码"
    >
      <Input
        v-model:value="store.settings.password"
        autocomplete="off"
        class="w-64"
        type="password"
      />
    </ProListItem>

    <ProListItem
      description="建议选择 OBS 中的桌面音频或音乐播放器来源，不要选择麦克风。"
      title="音频源"
    >
      <Select
        v-model:value="store.settings.inputName"
        allow-clear
        class="min-w-64"
        :disabled="store.status !== 'connected' || inputOptions.length === 0"
        :options="inputOptions"
        placeholder="连接后选择音频源"
        show-search
      />
    </ProListItem>

    <ProListItem
      description="当前只显示 OBS 音量表中的实时能量，未录制或上传音频。"
      title="实时音量"
    >
      <div class="w-64 flex items-center gap-2">
        <div class="bg-fill-tertiary h-2 flex-1 overflow-hidden rounded-full">
          <div
            class="h-full transition-[width] duration-75 bg-blue-5 rounded-full"
            :style="{ width: levelWidth }"
          />
        </div>
        <span class="w-14 text-right color-text-tertiary text-xs">
          {{ Math.round(store.levelDb) }} dB
        </span>
      </div>
    </ProListItem>

    <ProListItem
      description="用于确认当前默认模型的左右手动作是否正常。测试不会向系统发送真实按键。"
      title="动作测试"
    >
      <Flex gap="small">
        <Button
          size="small"
          @click="testAction('left')"
        >
          测试左手
        </Button>
        <Button
          size="small"
          @click="testAction('right')"
        >
          测试右手
        </Button>
        <Button
          size="small"
          @click="testAction('both')"
        >
          测试双手
        </Button>
      </Flex>
    </ProListItem>

    <ProListItem
      description="重音触发后会短暂点亮。"
      title="律动指示"
    >
      <Flex
        align="center"
        gap="small"
      >
        <span
          class="size-2.5 transition-colors rounded-full"
          :class="beatActive ? 'bg-green-5 shadow-[0_0_8px_var(--ant-color-success)]' : 'bg-fill-tertiary'"
        />
        <span class="color-text-tertiary text-xs">{{ beatLabel }}</span>
      </Flex>
    </ProListItem>

    <ProListItem
      description="数值越高，越容易把较轻的音量变化识别为敲击。"
      title="灵敏度"
      vertical
    >
      <Slider
        v-model:value="store.settings.sensitivity"
        class="m-0!"
        :max="2"
        :min="0.5"
        :step="0.1"
        :tooltip="{ formatter: value => `${value}` }"
      />
    </ProListItem>

    <ProListItem
      description="避免同一个重音在 OBS 的连续音量更新中被重复触发。"
      title="最短敲击间隔"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="store.settings.minIntervalMs"
          class="w-20"
          :max="500"
          :min="60"
        />
        <SpaceAddon>ms</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="达到此强度时会同时触发左右手。"
      title="双手重拍阈值"
    >
      <InputNumber
        v-model:value="store.settings.strongThreshold"
        class="w-20"
        :max="4"
        :min="1.4"
        :step="0.1"
      />
    </ProListItem>

    <ProListItem
      description="清空音频源并恢复本机 OBS 的常用默认连接参数。"
      title="恢复默认参数"
    >
      <Button @click="resetDefaults">
        恢复默认
      </Button>
    </ProListItem>

    <Alert
      message="需要 OBS 28 或更高版本；默认只连接本机 127.0.0.1。远程地址请确认网络可信。"
      show-icon
      type="info"
    />
  </ProList>
</template>
