# OBS 音频桥接与 Browser Source 宠物

这个桥接器配合 OBS 的 Browser Source 使用，不修改官方 BongoCat Release，也不向 Windows
发送任何模拟键盘。叠加层复用仓库内的默认键盘模型、Live2D 动作和按键图片。

工作方式：

1. 通过 OBS WebSocket 读取指定音频源的 `InputVolumeMeters`。
2. 使用项目里的自适应 onset 节拍检测器识别鼓点/音量突增。
3. 只在 `127.0.0.1` 的本地事件流发送 `LEFT`、`RIGHT` 或 `BOTH` 节拍。
4. Browser Source 页面在自己的画布中驱动 BongoCat，不会影响 OBS、游戏、聊天或输入框。

## 启动

在项目目录执行：

```powershell
scripts\start-obs-bongocat.cmd --input "桌面音频"
```

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
- 桥接器只监听 `127.0.0.1`，事件内容仅包含音量和节拍，不包含音频录音。
- `--dry-run` 只识别节拍，不驱动 Browser Source，适合检查音频源是否有活动。
- 停止桥接器请按 `Ctrl+C`。官方 BongoCat 可以单独关闭。
