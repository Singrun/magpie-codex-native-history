# Magpie Codex 原生路由历史兼容插件

[English](README.md)

这个插件解决通过 [Magpie](https://github.com/yetone/magpie) 使用 Codex 时，**已有聊天切回原生模型后，因旧加密推理历史报错而无法继续提问**的问题。它在保留可读消息、图片和工具记录的前提下，处理发往原生服务的不兼容历史项，让这类聊天能够继续工作。

## 要解决什么问题

典型使用场景是：

1. 你通过 Magpie 选择第三方模型，在同一条 Codex 聊天里完成多个回合，已经积累了对话、文件分析或工具调用记录。
2. 你保留这条聊天，改选原生 Codex 模型，准备继续工作。
3. 下一次提问却收到加密内容验证错误；改回第三方模型，这条聊天又可能继续使用。

常见报错如下：

```text
invalid_encrypted_content
The encrypted content for item rs_… could not be verified.
Reason: Encrypted content could not be decrypted or parsed.
```

原因在于，客户端重发的历史不只有界面上可读的问答，还包含此前模型返回的加密推理状态。切换上游后，原生服务可能无法验证某些旧密文，从而拒绝整个请求。

**本插件的目标是让你继续使用原来的聊天，保留已经积累的工作上下文。** 它在原生请求发出前，移除不兼容的旧推理项，并处理相关搜索历史和服务器条目 ID；保留已有可读消息、图片、工具参数与结果，以及工具调用配对。

请求仍需经过 Magpie。原生压缩项会原样保留，由能够读取它的原生上游处理；插件继续清理其余不兼容历史。插件不解密压缩内容，也不恢复无法读取的服务端上下文，详见下文“边界与诊断”。

## 为什么使用请求钩子

Magpie 的原生 ChatGPT 登录透传分支调用 `gatewayHooks`，跳过同步 `magpie.middleware` 链。只在同步中间件内过滤历史，覆盖不到这条原生路由。

本插件注册为 **`magpie.hooks`**。原生透传分支会调用它。Magpie 接收 WebSocket 的后续回合时，也会先还原完整历史，再经过相应 HTTP 处理入口，因此该路由上的钩子能够处理还原后的输入。

规范见 Magpie 的[中文插件开发与发布文档](https://usemagpie.ai/docs/zh/plugins)及[请求钩子实现契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md)。

## 安装

需要支持 `magpie.hooks` 的 Magpie 版本。原始实现已在 **0.1.4226** 上完成真实链路验证，公开包在 **0.1.4280** 上检查加载；**1.0.1** 的混合压缩历史修复在 **0.1.4363** 上验证，**1.0.2** 在 **0.1.4379** 上复核。这些是已验证版本，不代表最低兼容版本。

```sh
magpie plugin add github:Singrun/magpie-codex-native-history
```

可选：明确将钩子超时设为两秒：

```sh
magpie plugin options github:Singrun/magpie-codex-native-history '{"gatewayTimeoutMs":2000}'
```

`package.json` 中的选项示例供编辑器初始化；实际配置以保存到插件条目的选项为准。

安装后检查插件页是否显示 **async gateway hook / `onRequest`**。仅看到同步中间件条目，不能证明安装正确。

若之前已安装本地版原生历史钩子，先在插件页关闭该条目，再启用本包；保持一份原生历史钩子运行。

本包无需构建、额外端口、供应商凭据或客户端配置改写，由 Magpie 提供 Bun 运行时。

## 处理范围

处理以下请求：

- `/backend-api/codex/responses`：无供应商前缀的模型，或 `codex/` 模型。
- `/v1/responses`、`/responses`：上述模型，且 Magpie 将客户端识别为 `codex`。

其他供应商前缀的模型原样通过。在共享的 Responses 入口上，其他客户端或身份不明的客户端也原样通过。钩子按调用时的模型名称判断范围，无法看到随后分组或回退选中的实际供应商。

对符合范围的请求，钩子执行三项处理：

1. 移除旧 `reasoning` 条目。
2. 将历史 `web_search_call` 转为有明确标记的助手文字，只保留原条目实际包含的数据。
3. 移除可携带明文的历史项中可选的服务器 `id`。

可省略 ID 的工具记录包括 function/custom/tool-search 调用与结果、computer 结果、shell/apply-patch 调用与结果，以及 MCP approval response。`call_id`、`approval_request_id` 和工具数据内部的 ID 保留。要求 ID 的服务器工具及未知类型保持原样，插件不把它们统一转为文字。

若历史包含原生压缩项，这三项处理仍对其他历史项生效；压缩项的 ID、密文和内部元数据全部原样保留。

用户消息、助手回答及其 `phase`、图片、工具参数和结果、`call_id` 配对、业务数据内部 ID、工具声明均保留。模型、工具选择、流式配置及对新加密推理内容的请求保持不变。插件不改写聊天文件或新响应。

即使旧内部推理可被读取，过滤时仍会移除这些推理项，因此后续回合无法复用被移除的持久化推理状态。这是为了可读历史迁移作出的取舍。

## 边界与诊断

原生压缩项（`compaction`、`context_compaction`、`compaction_summary`）保持原样，其他历史项继续过滤。这覆盖了“先由原生模型压缩，再使用第三方模型，最后切回原生”的场景，前提是原生上游能读取保留的压缩项。插件不解密压缩内容，也不能让不兼容的上游读取它；若上游本身无法读取，仍可能报错。

对于密封消息内容、`item_reference`、`previous_response_id` 或服务端 `conversation` 引用，插件会保留整份请求，报告 `unavailable`，由上游决定能否接受。**这也是剩余的漏过滤条件：若它们和第三方推理同处一个请求，第三方推理仍会通过。** 服务端引用可能指向原条目 ID，密封任务也可能只由原上游读取，因此不能直接删除引用或密文来绕开错误。

普通 Magpie WebSocket 续接中，网关会先还原完整输入并移除 `previous_response_id`，再调用钩子。直接发送含服务端引用的 HTTP 请求属于另一种情况。

专用 `/responses/compact` 调用和 Magpie 内部请求不在本钩子范围内。按 Magpie 的契约，钩子失败或超时也会回滚，本来的请求可能继续送往上游。

诊断使用 Magpie 宿主允许的固定代码：

- `ready`：钩子完成修改；它表示过滤已执行，上游是否成功需看请求结果。
- `unavailable`：因上述不透明上下文保留整份请求，未过滤。

字节数为 `0`，表示本插件没有添加外部召回内容。无需为了诊断再次序列化整份图片历史。1.0.0/1.0.1 使用的 `native-history-*` 自定义代码不在宿主允许列表中，会被忽略；1.0.2 修正了这一诊断问题。宿主自己记录的 `timeout`、`error` 则表示钩子超时或执行失败。

插件不读取磁盘，不记录、保存或导出请求内容、账号标识和凭据，只处理 Magpie 提供的请求对象与上下文。

## 仍可能遇到的问题

| 情况 | 可能表现及处理 |
| --- | --- |
| 混合供应商分组、智能路由或自动回退到 Codex | `group/…` 等模型名称不会触发本钩子的原生过滤。共享入口上的无前缀名称也不构成实际供应商证明。需要确定覆盖时，明确选择原生模型或 `codex/…`；完整的混合分组支持需要供应商确定后的处理入口。 |
| 切换账号、API key，或中转在多个上游之间分配请求 | 旧压缩项、密封任务或加密函数参数可能只由原服务读取。Magpie 会对它记录过的压缩项追踪来源，但来源未知或原服务不可用时仍可能失败。保留原可读上下文，并回到能读取密文的路由；本插件不解密它们。 |
| 服务端引用或密封消息混入历史 | `unavailable` 表示整包保留。普通 WebSocket 续接通常已经展开历史；直接 HTTP 服务端引用和多智能体密封任务需要单独判断。 |
| 新工具类型，或服务器工具依赖旧推理/审批记录 | 必需 ID 的类型保持原样；保留不等于跨上游可用。出现 item-not-found、缺失配对或 encrypted-function-args 错误时，按实际类型和依赖补支持。不得用批量删除工具结果处理。 |
| 插件超时、宿主启动失败，或其他插件改变同一请求 | Magpie 的钩子按顺序运行，失败时回退到最后一次接受的请求。查看 `timeout`/`error` 与最终请求结果，确认只有一份同类钩子启用；后续钩子或同步中间件可能再改写历史。 |
| 压缩请求、标题、摘要或其他内部调用失败 | 专用 `/responses/compact` 与 Magpie 自己发起的调用不经过本钩子。先辨认失败操作，再判断应修客户端、网关还是此插件。 |
| 更新源码后仍运行旧副本 | 核对启用条目的安装路径与版本，关闭再开启以重载。GitHub 源码、release 包和当前安装目录是分别更新的。 |

排查时先记录实际模型和供应商、失败端点、错误代码与钩子状态。`invalid_encrypted_content`、`previous_response_not_found`、上下文超限及 401/429/5xx 应分别处理；原生过滤成功不会解决账号、额度和服务可用性问题。

## 测试与开发

开发测试使用 Node.js 22 或更新版本。仓库中的测试数据均为合成数据，不需要模型 API 或账号。

```sh
git clone https://github.com/Singrun/magpie-codex-native-history.git
cd magpie-codex-native-history
npm run check
npm run pack:check
```

从源码目录加载：

```sh
magpie plugin add .
```

单独修改源文件后，需要重新加载插件配置；关闭再开启插件可重载宿主。测试源码版之前，先关闭另一份同类钩子。

原始真实回归使用了包含图片和工具记录的完整历史，共 149 个历史项、约 17.98 MB 输入。关闭钩子可重现同一密文错误，开启后 HTTP 与 WebSocket 均通过；同一个 WebSocket 完成“第三方 → 原生 → 第三方 → 原生”四轮切换，保留了合成的上下文验证标记。

**1.0.1 修复了混合压缩历史漏过滤的问题。** 1.0.0 遇到压缩项时会跳过整个请求，导致后续第三方推理项也被放行。新的真实回放包含原生压缩项及其后的第三方历史，共 200 个输入项；旧版重现密文错误，修复后原生请求通过。带同一份混合历史的单个 WebSocket 也完成四轮来回切换，并保留验证标记。合成测试覆盖压缩项完整保留和其他历史项继续清理。

**1.0.2 补齐诊断契约、路径别名与已知历史格式。** 新增 `/responses` 覆盖、`compaction_summary` 保留和六类可省略服务器 ID 的工具项；诊断改为宿主实际接受的 `ready`/`unavailable`。这些格式与保全检查使用合成回归测试，实际混合聊天仍通过原生 HTTP 与 WebSocket 切换复核。

这些结果限定于已验证环境，不代表所有网关、账号、模型及历史格式。真实聊天记录、账号信息、认证读取脚本、本地备份和原始真实回放脚本均不进入公开仓库。

## 停用或卸载

```sh
magpie plugin off github:Singrun/magpie-codex-native-history
# 或卸载：
magpie plugin rm github:Singrun/magpie-codex-native-history
```

## 许可与致谢

采用 [MIT](LICENSE) 许可。前序历史过滤项目的来源与版权说明见 [NOTICE](NOTICE)。本项目是独立社区插件。
