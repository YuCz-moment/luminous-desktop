# Luminous Desktop（流光桌面版）

流光（Luminous）无限画布的桌面客户端，基于 Tauri 2，支持 Windows / macOS（Intel + Apple Silicon）。

## 本地开发

```
npm install
npm run dev      # 开发模式：本地 4521 服务 + Tauri 窗口
npm run build    # 打 release 安装包（Windows: bundle/nsis/，macOS: bundle/dmg/ + bundle/macos/）
```

## 结构

- `public/` — 前端页面（打包时内嵌进应用）
- `server.js` — Node sidecar，提供 AI / 网页抓取 / 导出临时文件等 API；作为资源随应用发布
- `src-tauri/binaries/` — 各平台嵌入的 Node 运行时（sidecar）
- `src-tauri/src/lib.rs` — 启动 sidecar、媒体导出（保存 / 剪贴板 / 拖出窗口）

## Sidecar Node 二进制

`tauri.conf.json` 中 `externalBin: ["binaries/node"]` 会按平台自动选择：

| 平台 | 文件名 | 来源 |
| --- | --- | --- |
| Windows x64 | `node-x86_64-pc-windows-msvc.exe` | nodejs.org v22.14.0 win-x64 |
| macOS Intel | `node-x86_64-apple-darwin` | nodejs.org v22.14.0 darwin-x64 |
| macOS Apple Silicon | `node-aarch64-apple-darwin` | nodejs.org v22.14.0 darwin-arm64 |

> 这些二进制体积超过 GitHub 100MB 单文件限制，因此不提交到仓库（已在 `.gitignore` 忽略）。本地构建时把文件放进 `src-tauri/binaries/` 即可；GitHub Actions 构建时会自动下载对应版本。

## GitHub Actions 自动构建

`.github/workflows/build.yml` 在推送 `v*` tag 或手动触发时，并行构建三个平台：

- Windows x64：NSIS 安装包（`.exe`）
- macOS Intel（`macos-15-intel`）：DMG + `.app.zip`
- macOS Apple Silicon（`macos-latest`）：DMG + `.app.zip`

推送 tag 后会自动生成一个 **draft Release**，审阅无误后发布即可分享给用户下载。

## macOS 说明

- 目前未做 Apple 开发者签名，用户首次打开需 **右键 → 打开**，或在 系统设置 → 隐私与安全性 中允许。
- 正式分发建议购买 Apple Developer（$99/年）并配置签名 + 公证，避免“已损坏/无法验证”提示。

## 桌面版特有功能

- 视频/音频卡片右键：保存到文件夹、复制文件到剪贴板（Windows 可用，macOS 暂不支持复制到剪贴板）
- 网页卡片「跳转」用系统默认浏览器打开
- 数据存在 `tauri://localhost` 源，与浏览器网页版不互通
