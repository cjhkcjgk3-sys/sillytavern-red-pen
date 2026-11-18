# AI 协作说明

本文件写给所有参与本仓库开发的 AI（Codex、GPT、Gemini、Claude、Grok 等）。

<!-- ai-dev-lessons:start -->

## 开工前必读：AI 经验仓库

> 本段由 [ai-dev-lessons](https://github.com/cjhkcjgk3-sys/ai-dev-lessons) 统一同步，所有 AI 都要遵守；与下文冲突时以本段为准。

1. **先读完 [ai-dev-lessons 的 `正式/`](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/tree/main/正式)**：通用准则、检查清单、工作流程、全部模型专项（不只读自己那份）。可 `git clone`／`git pull` 该仓库，拉不到就看网页版，并在汇报里写明没读到哪些。开工汇报第一句写本次相关的条目编号。
2. **先查能不能复用**：本仓库已有代码、SillyTavern 自带功能、兄弟插件，汇报里写明查了哪些。
3. **大改先提方案**：改布局、改交互方式、改数据格式、删功能前，按[方案确认](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/方案确认.md)发给用户，等回复“可以”再动手。
4. **第三次就停**：同一问题修到第 3 次还没好，停止打补丁，按[重新设计](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/重新设计.md)交方案，等用户确认。
5. **边做边记，分清通用和专门**：只在本插件出现的专门问题记在本仓库 [docs/问题记录.md](docs/问题记录.md)；写任何代码都可能遇到的通用问题，按[待审条目](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/待审条目.md)交到 ai-dev-lessons 的 `待审/`，本仓库只留一行链接；拿不准的先记本仓库并标“可能通用”。小问题写清原因、解决、状态，大问题写完整（[小](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-小.md)／[大](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-大.md)）。
6. **版本更新要署名**：谁做正式的版本更新或合并，谁就在 `CHANGELOG.md` 对应版本标题下写一行 `更新人：家族名`（Grok、GPT、Gemini、Claude、DeepSeek，用户自己改的写 human），只写家族名不写型号。只读、查看、审查不用署名；从下一次版本更新开始执行，以前的版本不补。
7. **收尾必须交[交付汇报](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/交付汇报.md)**：“未验证”和“同一问题第几次修”不能省略，没有就写“无”。
8. **待审不是规则**：ai-dev-lessons 里只有 `正式/` 算规则，`待审/` 只供参考；不要直接改它的 `正式/`。

<!-- ai-dev-lessons:end -->
