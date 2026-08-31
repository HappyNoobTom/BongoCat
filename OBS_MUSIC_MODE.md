# BongoCat OBS 音乐律动（v0.4）

这个版本直接基于 BongoCat 自带的模型和动作链路，新增了一个可供 OBS 使用的 Browser Source 音乐桥。
推荐的频谱模式从 Windows 播放设备读取 PCM，再做 FFT；它不录音、不保存音频，也不会向系统发送真实键盘按键。

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
Windows 默认播放设备
        ↓ WASAPI loopback（audio_capture Release）
48kHz PCM16（50ms 分块）
        ↓ fft.js：2048 FFT + Hann 窗 + 512 hop
低 / 中 / 高频 + spectral flux
        ↓ 动态阈值、局部峰值、70ms 安全底线、低频 BPM 估计
        ↓
本地 SSE
        ↓
OBS Browser Source 中的 BongoCat 模型
```

也保留旧的 OBS 音量模式：不带 `--spectrum` 时，通过 `obs-websocket-js` 读取约 20Hz 的
`InputVolumeMeters`，使用 magnitude（RMS）、快慢包络、最近约 1.8 秒的中位数/MAD 动态阈值和三点局部峰值。
它适合作为采集程序不可用时的后备，但无法获得频谱信息。

频谱模式的三个频段为：

- 低频 30–180Hz：主要对应底鼓和低频律动，驱动左右手交替，并参与 BPM 估计。
- 中频 180–2500Hz：主要对应军鼓、拍手和主体打击乐，填充另一只手。
- 高频 2500–10000Hz：只显示，不默认触发，避免镲片噪声造成连击。

动作映射如下：

- 普通重音：默认键盘模型左右手交替。
- 强重音：左右手同时按下，动作持续时间稍长。
- 无音量或低于静音阈值：不触发动作；已有动作会在短延迟后释放。

“动作输出延迟”是可调的同步补偿项，默认 `0ms`；它只会把已检测到的动作向后推迟，不能提前预测尚未到来的节拍。

代码入口：

- `src/composables/useObsAudio.ts`：连接 OBS、同步设置、动作适配和重连。
- `src/services/rhythmDetector.ts`：独立的音量转重音检测器。
- `src/stores/obsAudio.ts`：持久化连接及检测参数。
- `src/pages/preference/components/obs-audio/index.vue`：设置界面。

新增依赖：

- `obs-websocket-js`（MIT）
- `simple-statistics`（ISC）
- `fft.js`（MIT）

频谱模式使用的 `audio_capture-windows-x64.exe` 不提交到本仓库，也不随项目重新打包；它由用户从
上游 Release 单独下载到本机 `D:\winutils\bongocat`。这样可以保留上游发布物的完整性，并避免把未明确
许可证的二进制文件重新分发。

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

- 频谱模式显示低/中/高频段和低频 BPM 估计；BPM 只用于反馈和调试，暂不自动预测缺失拍点。
- 输入源必须先在 OBS 中存在并有音量活动；选择的源没有音量时，宠物会保持待机。
- WASAPI 模式读取的是 Windows 默认播放设备，不会自动包含 OBS 内部滤镜、独立监听设备或虚拟声卡中的其他信号。
- 如果后续需要严格跟随 OBS 混音，可做原生 OBS raw-audio 插件，再把同样的频谱/节拍结果接入动作适配器。
