# Multi-Char TTS · 酒馆多人分角色朗读

为 SillyTavern（酒馆）多人角色卡设计的 TTS 方案：AI 按 `【人名】：“English.”（中文翻译）` 格式输出多人对话，聊天中每句对话后自动出现 🔊，点击即用该角色的音色念出英文台词（翻译不会被念）。

## 安装

**方式一（推荐，一键）**：酒馆 → 插件管理 → 安装扩展（从 Git）→ 粘贴 `https://github.com/haodayizhiyu404/TTS`，装完刷新页面。

**方式二手动**：把仓库根目录的 `manifest.json` / `index.js` / `style.css` 三个文件放进 `<酒馆目录>/public/scripts/extensions/third-party/multi-char-tts/`，重启酒馆。

装好后在插件管理里启用，展开面板配置。

## 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` / `index.js` / `style.css` | 扩展本体（仓库根目录即扩展目录） |
| `loader.js` / `multi-char-tts.js` | 旧版（酒馆助手脚本 + 远程加载），保留兼容，不再更新 |

## 引擎配置

### Fish Audio（推荐，高仿真）

- 需要酒馆 `config.yaml` 里 `enableCorsProxy: true`（请求走酒馆 /proxy 转发，解决浏览器跨域）
- 去 [fish.audio](https://fish.audio/) 注册 → 「开发者」页面创建 API key
- 免费模型 `s2.1-pro-free`（官方免费开发者档，无额度承诺，随时可能调整）
- 音色：「发现」广场打开任意声音页面，复制 model id 填到角色行里

### Edge TTS（免费稳定，质感一般）

- 需要 SillyTavern-EdgeTTS-Plugin 服务端插件（或 Extras 的 edge-tts 模块）
- 音色下拉框自动列出全部 322 个

## 角色卡配合

世界书输出规则：多人对话严格使用 `【人名】：“英文台词.”（中文翻译）`，每段独立成行；角色名与扩展里绑定的名字一致（是故事内人物名，不是卡名）。音色表存在角色卡上，随卡导出。

## Termux（仅手机）用户

同样用方式一安装扩展；`config.yaml` 的 `enableCorsProxy: true` 同样适用。
