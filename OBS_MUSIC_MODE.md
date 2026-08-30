# BongoCat OBS 音乐律动（v0.1）

这个版本直接基于 BongoCat 自带的模型和动作链路，新增一个“OBS 音乐律动”设置页。它只读取 OBS WebSocket 推送的音量表，不录音、不保存音频，也不会向系统发送真实键盘按键。

如果你使用官方已经编译好的 Windows Release，不能把代码里的设置页直接替换进去；请使用
[OBS Browser Source 桥接器](./OBS_BONGOCAT_BRIDGE.md)。它在 OBS 内部渲染同一套默认模型，安全性和动作效果一致。

## 使用方法

1. 使用 OBS 28 或更高版本，打开“工具 → WebSocket 服务器设置”。
2. 启用 WebSocket 服务器，确认端口（默认 `4455`）和密码。
3. 启动 BongoCat，在设置中打开“OBS 音乐律动”。
4. 填入 OBS 地址、端口和密码，连接成功后选择要跟随的音频源。
5. 建议选择“桌面音频”或音乐播放器来源。先用“测试左手 / 测试右手 / 测试双手”确认当前模型动作正常，再播放音乐微调灵敏度。

默认地址是 `127.0.0.1`。如果改成远程地址，初版使用的是普通 `ws://` 连接，请只在可信局域网中使用；不会把音频数据上传到第三方服务。

如果 OBS 被关闭，BongoCat 会释放当前动作并自动重连；关闭音乐模式后，原来的键盘、鼠标和手柄模式会恢复。

## 实现范围

```text
OBS InputVolumeMeters
        ↓
obs-websocket-js（本地 WebSocket）
        ↓
自适应重音检测（快慢包络 + 中位数/MAD 阈值）
        ↓
轻拍 / 普通重音 / 强重音
        ↓
BongoCat 现有 handlePress / handleRelease
```

初版使用 OBS 的 `InputVolumeMeters` 事件。OBS 提供的是约 20Hz 的音量表数据，而不是原始 PCM，因此这里检测的是“音量突然上升的重音”，不是频谱级的底鼓识别或精确 BPM。算法会使用最近约两秒的样本自适应阈值，并用最短间隔避免重复触发。

动作映射如下：

- 普通重音：默认键盘模型左右手交替。
- 强重音：左右手同时按下，动作持续时间稍长。
- 无音量或低于静音阈值：不触发动作；已有动作会在短延迟后释放。

代码入口：

- `src/composables/useObsAudio.ts`：连接 OBS、同步设置、动作适配和重连。
- `src/services/rhythmDetector.ts`：独立的音量转重音检测器。
- `src/stores/obsAudio.ts`：持久化连接及检测参数。
- `src/pages/preference/components/obs-audio/index.vue`：设置界面。

新增依赖：

- `obs-websocket-js`（MIT）
- `simple-statistics`（ISC）

## 本地开发

```bash
pnpm install
pnpm dev
```

构建检查：

```bash
pnpm build:vite
pnpm exec eslint src --no-fix
```

如果 pnpm 提示某些依赖的构建脚本需要批准，请按 pnpm 的提示批准后再执行完整的 Tauri 构建；Vite 前端构建不依赖 OBS 运行中的实例。

## 当前限制与后续升级

- 初版不显示 BPM，也不区分低频/高频；这是 OBS 音量事件数据粒度决定的。
- 输入源必须先在 OBS 中存在并有音量活动；选择的源没有音量时，宠物会保持待机。
- 如果后续需要更准确的节拍，可增加独立的 PCM 捕获层，再把频谱/节拍结果接入同一个动作适配器，不需要改 BongoCat 模型。
