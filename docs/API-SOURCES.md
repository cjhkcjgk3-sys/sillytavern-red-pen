# API 与运行合同

## 开发基准

- 上游：SillyTavern/SillyTavern。
- 指定提交：`06bde939fb1e9c4c8d8641d810f0a916b5bce127`。
- 该提交 `package.json` 版本：`1.19.0`。
- 取证日期：2026-11-06。下载源码并逐项检查，未连接用户的已安装酒馆。
- 本扩展运行于酒馆主页面；不是角色卡脚本，也不是服务器插件。
- 运行依赖全部为酒馆和浏览器提供，无 Tavern Helper、MVU、CDN、外部数据库依赖。

以下链接均固定到同一提交，避免把移动分支当成目标版本事实：

| 能力 | 指定源码依据 | 本插件用法与核验层级 |
| --- | --- | --- |
| `SillyTavern.getContext()` | [st-context.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js) | 读取聊天、完整性标识、事件、主 API、分词器及聊天补全设置；源码核对 + 本地模拟合同测试 |
| `saveMetadata()` / `saveChat()` | [script.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js) | 原生保存可能吞掉异常，不能仅凭 Promise 返回宣称保存成功；本插件观察匹配聊天保存 HTTP 响应，确认标识已保存 |
| `getCurrentUserHandle()` | [user.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/user.js) | 唯一内部模块导入 `/scripts/user.js`，用于浏览器库账号隔离；不是密钥接口。使用站点根路径部署，子路径反向代理未测 |
| `GENERATION_STARTED(type, options, dryRun)` | [script.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js) 与 [events.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/events.js) | 冻结正常生成启动时的开关、聊天身份与记录；dryRun 和 quiet 不创建附加快照 |
| `GENERATION_ENDED` / `GENERATION_STOPPED` | 同上 | 清理活动快照；已提交的请求不会因开关或取消而被声称撤回 |
| `CHAT_CHANGED` / 消息事件 | [events.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/events.js) | 清理旧界面和范围，重新读取当前库 |
| `MESSAGE_SWIPE_DELETED({messageId, swipeId, newSwipeId})` | [script.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js) | 原生删除回答版本后，只在原文修订指纹一致时更新存活版本索引；已删除版本保留摘录并停止标红 |
| `generate_interceptor` | [extensions.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js) | 全局 `redPenGenerationInterceptor(chat, contextSize, abort, type)`；不支持的主 API 与库读取失败调用 `abort(true)` |
| 请求提交与格式 | [openai.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js) | 正常聊天补全会向同源 `/api/backends/chat-completions/generate` POST JSON，含 `type`、`messages`、`max_tokens`、`chat_completion_source` |
| Google / Vertex 适配 | [chat-completions.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/backends/chat-completions.js) | 由酒馆服务器转换为 Google 原生格式并处理认证；插件不另建 API 客户端 |
| 分支与聊天完整性标识 | [bookmarks.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/bookmarks.js) | 原生分支生成新 `integrity`，元数据含 `main_chat`，消息按所选范围复制；插件只复制可确认的对应来源记录 |
| 压缩聊天保存请求 | [request-compression.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/request-compression.js) | 观察保存时支持 `Content-Encoding: gzip` 的解码；不能识别的保存不当作成功 |
| 扩展目录与生命周期 | [extensions.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/extensions.js) 与 [前端加载器](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js) | 用户扩展位于 `data/<handle>/extensions/<extension>`；全局目录位于 `public/scripts/extensions/third-party/<extension>`。导出 enable / disable / clean / delete hooks |

## 为什么使用范围受限的 fetch 包装

该版本的事件分发器会捕获并吞掉事件回调中的异常。因此仅在 `CHAT_COMPLETION_SETTINGS_READY` 事件中抛错，不能保证容量不足时阻止真实发送。

本插件配对安装、清理一个同源请求包装：只处理明确的聊天保存端点和原生聊天补全生成端点。生成材料在请求序列化前加入；提交前重新解析 JSON 并比对完整 `content`。阻止发送发生在原始 fetch 之前。不会把密钥、整个请求体或聊天内容写入 console。后台 `quiet` 请求原样通过。

停用时恢复自身拥有的 fetch 包装。如果其他扩展在之后又包了一层 fetch，不覆盖它；已停用的本插件层只透传。与同一时刻另行构造正常请求、改写端点或覆盖 fetch 的扩展需要专项联测，当前未支持并发生成。

## 持久化与定位

浏览器库版本为 1；数据库 `sillytavern-red-pen`，对象仓库 `libraries` / `settings`。聊天 key 由账号、角色头像标识或群组、原生聊天 `integrity` 构成。扩展不依赖文件名归属，因此重命名不串库。

来源使用原生消息日期、说话人身份、回答版本索引与修订指纹；可见文本投影保存字符范围与指纹。指纹是两组 64 位 FNV-1a 加长度，用于检测修订，不用作密码学认证。消息身份冲突、来源变化或投影不符时拒绝重新标红。外部工具重写消息身份、回答数组或修改日期时只保证保留原摘录，准确回到来源需另验。

普通文字投影折叠显示空白，并插入结构段落换行；代码保持空白。投影把每个可见字符映射回 DOM Range。高亮使用 CSS Custom Highlight API，不把 span 写进正文，也不改变 `mes`。思考、隐藏节点、控制按钮和媒体不参与摘录。跨消息、跨表格单元格与媒体内选区明确拒绝。

## 技能与参考回执

主工作流：`sillytavern-extension-dev`；精确接口核验：`sillytavern-api-reference`。手工路由依据 `consult-tavernweave-library` 的 route-map（2026-09-13）和 library-manifest（2026-08-18）。已读取运行合同、扩展合同、前端质量说明；没有物化的库查询器，未执行确定性路由脚本。

ST-A0、ST-D5 与 ST-E5 的中文路径资源尝试读取失败，未伪称已加载；本任务继续依据用户完整蓝图及指定上游源码实现。没有加载或分发私有资料。前端沿用酒馆样式和系统原生选区；已查看本地 Chromium 的桌面、手机尺寸深浅色截图。外部设计页面未做渲染考察。

上述源码核验不是用户运行环境验收。真实安装、生命周期、安卓原生选区、实际 OpenAI 与 Google 请求仍是下一道验收门。
