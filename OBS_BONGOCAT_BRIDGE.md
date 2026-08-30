# OBS 音频桥接与 Browser Source 宠物

这个桥接器配合 OBS 的 Browser Source 使用，不修改官方 BongoCat Release，也不向 Windows
发送任何模拟键盘。叠加层复用仓库内的默认键盘模型、Live2D 动作和按键图片。

工作方式：

默认推荐使用“Windows WASAPI 频谱模式”：

1. `audio_capture-windows-x64.exe` 通过 WASAPI loopback 读取 Windows 默认播放设备的原始 PCM。
2. `fft.js` 对 48kHz PCM 做 2048 点 FFT（Hann 窗、512 点 hop），得到低频 30–180Hz、中频
   180–2500Hz 和高频 2500–10000Hz。
3. 对各频段做 spectral flux、动态中位数/MAD 阈值、三帧局部峰值和全局冷却；低频节拍还会估计 BPM。
   高频只用于频谱显示，默认不直接驱动动作，避免镲片和噪声造成连击。
4. 只在 `127.0.0.1` 的本地事件流发送 `LEFT`、`RIGHT` 或 `BOTH` 节拍。
5. Browser Source 页面在自己的画布中驱动 BongoCat，不会影响 OBS、游戏、聊天或输入框。

仍保留 `InputVolumeMeters` 音量模式作为后备，可不带 `--spectrum` 启动。两种模式都使用同一个
Browser Source 和动作映射。

## 启动

在项目目录执行：

```powershell
scripts\start-obs-bongocat.cmd --input "桌面音频"
```

### 频谱模式（推荐）

采集程序已放在本机 `D:\winutils\bongocat\audio_capture-windows-x64.exe` 时，直接运行：

```powershell
scripts\start-obs-bongocat.cmd --spectrum --add-source --gui-password
```

现在也提供了一个统一入口：

```text
D:\winutils\bongocat\BongoCat-OBS.cmd
```

双击它即可启动桥接器、Vite 叠加层和音频分析链路；首次使用仍会弹出 OBS 密码输入框。该入口本身不
包含 OBS，OBS 继续作为外部 Browser Source 宿主运行。

也可以显式指定采集程序路径：

```powershell
scripts\start-obs-bongocat.cmd --spectrum `
  --spectrum-capture "D:\winutils\bongocat\audio_capture-windows-x64.exe" `
  --add-source --gui-password
```

如果动作偏少，可把灵敏度提高到 `1.2`；如果连击偏多，可把最短间隔提高到 `260` 毫秒：

```powershell
scripts\start-obs-bongocat.cmd --spectrum --sensitivity 1.2 --min-interval 260
```

程序没有内置或重新打包该 EXE；找不到时会提示从
<https://github.com/huxinhai/audio-capture/releases/latest> 下载 Windows x64 Release。
也可设置 `BONGO_AUDIO_CAPTURE` 环境变量指定路径。若启动时找不到采集程序，会自动回退到 OBS 音量模式；
采集数据只在内存中经过 FFT，不保存音频文件。

首次使用建议让桥接器自动添加 Browser Source：

```powershell
scripts\start-obs-bongocat.cmd --input "桌面音频" --add-source --gui-password
```

它会把名为“BongoCat 音乐宠物”的来源加入 OBS 当前节目场景，并自动放在右下角。
来源地址默认是 `http://127.0.0.1:1420/obs-overlay.html`，本地 Vite 页面由桥接器自动启动。

如果 OBS WebSocket 密码没有放在环境变量里，启动时会在当前终端隐藏输入：

```powershell
$env:OBS_WEBSOCKET_PASSWORD = '只在本机设置，不要发到聊天'
scripts\start-obs-bongocat.cmd --input "桌面音频"
```

也可以强制弹出本机密码对话框，适合双击启动：

```powershell
scripts\start-obs-bongocat.cmd --input "桌面音频" --gui-password
```

也可以先只检测节拍、不驱动画面：

```powershell
scripts\start-obs-bongocat.cmd --input "桌面音频" --dry-run
```

## 注意

- OBS 中需要启用 WebSocket 服务器，默认地址是 `127.0.0.1:4455`。
- 如果 OBS 开启了身份验证，密码只在本机输入；桥接器不会打印或写入密码。
- 桥接器只监听 `127.0.0.1`，事件内容仅包含频段数据和节拍，不包含音频录音。
- `--dry-run` 只识别节拍，不驱动 Browser Source，适合检查音频源是否有活动。
- 频谱模式捕获的是 Windows 默认播放设备，不是 OBS 内部混音。如果 OBS“桌面音频”使用的正是该
  设备，二者基本一致；若使用虚拟声卡、应用音频捕获、独立监听设备或 OBS 音频滤镜，信号可能不同。
- 频谱 flux 是实时 onset 检测，不是离线音轨分析器；它比 OBS 音量表更能区分底鼓/军鼓，但不会保证
  每首歌的每一个拍点都完美命中。BPM 目前只用于稳定显示和日志，不会自行“补造”音频中不存在的拍点。
- 停止桥接器请按 `Ctrl+C`。官方 BongoCat 可以单独关闭。
