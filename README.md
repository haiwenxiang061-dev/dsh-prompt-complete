# dsh-prompt-complete

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-3b82f6.svg)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-4d6bfe.svg)](https://github.com/deepseek-ai/deepseek-harness)

「完善提示词」— 一个 DSH 双半插件。点一下输入框右边的**完善**按钮，宿主会读出本对话的历史，把你当前草稿改写成一个完整、精确、可直接发送的提示词，并回填到输入框；12 秒内可撤销。

## 它做什么

- 读当前 session 的 `deriveMessages()`（模型真正看到的消息序列），取最近 24 条 user/assistant 轮次。
- 用**该 session 自己的 provider/model**（`requestHeader().config`）发起一次改写，不需要额外配置模型。
- 改写规则：保留原意图与全部已有约束；把隐含的诉求显式化（目标、现状、要改什么、验收标准、不可触碰的部分）；用对话里的真实事实（路径、报错、决策）消解代词与悬空引用；不臆造路径/API/版本。草稿为空时，依据对话里的未完成工作推断下一条最该发的消息。
- 结果回填输入框，附带**撤销**。

## 安装

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-prompt-complete
dsh plugin --profile desktop add dsh-prompt-complete
```

`desktop` 是带窗口的桌面 profile，`web` 是浏览器 profile；把 profile 名换成你实际要装的那个。
装完刷新页面即可在 composer 工具行看到按钮（`conversation.input.right`，order 60），行内标注 **提示词完善**。

npm 上已发布 `1.0.0`，用 `npm view dsh-prompt-complete version` 可查最新版。

### 方式二：从 GitHub 安装（不走 npm 时用）

钉住 tag 的 tarball 地址，下载后直接解包安装，不需要 git 传输：

```bash
dsh plugin --profile web add https://codeload.github.com/haiwenxiang061-dev/dsh-prompt-complete/tar.gz/refs/tags/v1.0.0
dsh plugin --profile desktop add https://codeload.github.com/haiwenxiang061-dev/dsh-prompt-complete/tar.gz/refs/tags/v1.0.0
```

Release 里也挂了同一份 `.tgz` 附件，想用 GitHub 的下载页可以换成：

```bash
dsh plugin --profile desktop add https://github.com/haiwenxiang061-dev/dsh-prompt-complete/releases/download/v1.0.0/dsh-prompt-complete-1.0.0.tgz
```

两点实测注意：
- `dsh plugin` 会把参数转发给 profile 目录里的 pnpm，所以本机需要能调到 `pnpm`（`npm i -g pnpm` 即可）。
- 不建议用 `github:haiwenxiang061-dev/dsh-prompt-complete` 这种简写：它走 git 传输协议，在国内网络下经常被 reset；上面的 codeload 地址走 HTTPS 下载，稳定得多。

> 包名说明：npm 上 `dsh-prompt-refine` 已被另一位维护者占用（功能是「发送前给出 3 条改进建议」，与本插件定位不同），所以这里改名为 `dsh-prompt-complete`，中文名仍为「提示词完善」。

装完宿主半**不会**热重载，改代码后要重启 Harness。用 `plugin_manager` `action=set_plugin` 把 `entryId`（`include:prompt-complete`）先 disable 再 enable 也能生效。

## 结构

```
package.json          # dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml      # - insert: prompt-complete
lib/index.js          # 宿主半：POST /dsh-prompt-complete/refine
client.js             # 客户端半：__ModuleLoader__ 静态 bundle
locale/{en,zh}.json   # meta.title / meta.description
icon.svg
test/pure.test.mjs    # 纯函数单测（转录裁剪 / 结果清洗 / 请求拼装）
test/host.test.mjs    # 宿主半：路由注册 / 斜杠命令 / 同源闸
test/client.test.mjs  # 客户端半：__ModuleLoader__ 加载 / 插槽注册 / 渲染不抛错
```

## 两个入口

**按钮（有界面时）**：composer 工具行右侧的「完善」。点一下 → 读草稿 → 请求宿主 → 回填 → 12 秒内可撤销。

**斜杠命令（无界面时）**：直接发 `/refine 你的草稿`，改写结果作为命令回复返回，不进入对话历史。草稿留空时依据当前对话推断下一条。

两者共用同一条宿主路径、同一套校验，只有出口不同。

## 宿主路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/dsh-prompt-complete/refine` | body `{ sessionId, draft }` → `{ ok, prompt, provider, model, finish, usage }` |
| `GET` | `/dsh-prompt-complete/status` | 存活探测，返回 `{ ok, plugin, build, maxTokens, temperature }` |

两条路由都过同源闸：`Host` 必须是 loopback，`sec-fetch-site` 不能是 `cross-site`，`Origin` 存在时必须与 `Host` 同源。否则 403。请求体上限 256 KiB。

## 配置

宿主半接受可选 `config`（在 `cordis.patch.yml` 的 `config:` 下给）：

```yaml
- insert:
    - id: prompt-complete
      name: dsh-prompt-complete
      config:
        maxTokens: 1600
        temperature: 0.2
        timeoutMs: 180000
```

## 失败时

按钮显示错误态并在上方浮出原因，输入框内容**不动**。「完善失败: …」后面是宿主返回的真实错误（例如 `no-model-route`、`empty-completion`、provider 的 failure code）。

## 已知边界

- 输入框里带引用 chip（`occurrences` 非空或处于 `claimed` 阶段）时拒绝执行——整段替换会丢掉 chip。清空后重试。
- 改写是一次额外的模型调用，会花 token。
- 客户端组件包了 error boundary：任何渲染异常只会让按钮消失，不会连累宿主 composer。

## 兼容与权限

| 项 | 说明 |
| --- | --- |
| DSH | 0.2.0-rc.2 ~ 0.2.x（`engines.dsh` = `>=0.2.0-rc.2 <0.3.0-0`） |
| Node | >= 22 |
| 平台 | 全平台（不依赖本机 GIS 软件） |
| 网络 | 不联网；只调本机 loopback 上的宿主路由 |
| 权限 | 读当前 session 的对话转录，并用该 session 自己的模型路由发一次请求 |
| 依赖 | 宿主需有 `webServer` 与 `llm` 能力（`dsh-base` 自带） |
| 许可证 | MIT |

## 许可

MIT，详见 [LICENSE](LICENSE)。
