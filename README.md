# TTS · 酒馆多人分角色朗读

为 SillyTavern（酒馆）多人角色卡设计的中文上手 TTS 方案：AI 按 `【人名】：对话` 格式输出多人对话，浏览器端逐段捕捉、按角色绑定的 Edge 音色依次发声。用户（自己）的消息不朗读，发新消息自动打断。

## 文件说明

| 文件 | 作用 |
|---|---|
| `loader.js` | **粘贴进酒馆助手（JS-Slash-Runner）的唯一文件**，绑定到角色卡；负责从本仓库拉取本体并执行 |
| `multi-char-tts.js` | 功能本体：格式解析、音色绑定 UI、播放队列、打断逻辑 |

## 使用前提

1. **发声后端（二选一，必须）**：
   - 推荐：安装 [SillyTavern-EdgeTTS-Plugin](https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin) 服务端插件（任何能跑酒馆的机器都行，含 Termux）
   - 或者：Extras API 的 `enable-modules` 中加入 `edge-tts`
2. **输出格式**：角色卡的世界书/预设中要求 AI 多人对话严格使用 `【人名】：对话内容` 格式，每段发言独立成行，角色名与设置面板里绑定的一致。

## 安装（卡的使用者）

1. 按上文装好发声后端并重启酒馆
2. 酒馆里打开 **酒馆助手（JS-Slash-Runner）→ 新建脚本**，把 `loader.js` 全文粘贴进去，绑定到角色卡
3. 导入/打开卡后，点右下角 **⚙️** → 添加角色行 → 手输**故事内的角色名**（不是角色卡标题）→ 选音色 → 🔊 试听 → 保存
4. 右下角 **🔊** 是总开关；播放中点击它立即停止

## 更新

维护者 push 本仓库后，所有用户下次打开聊天时自动加载新版，无需任何手动操作。

## Termux（仅手机）用户装后端

```bash
pkg install git
cd <酒馆目录>/plugins
git clone https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin
cd SillyTavern-EdgeTTS-Plugin && npm install --omit=dev
```

然后编辑酒馆 `config.yaml`：`enableServerPlugins: true`，重启酒馆。
