# Resume Optimizer

本地优先的求职工作台：把已有简历经历，用岗位 JD 的原词改写清楚，再写回你导入的 Word 母版。

不替你编经历、不接项目云数据库、不替你保管模型 Key。你导入 `.docx`、自己填 OpenAI 兼容接口，系统只抽取可核对事实、对照 JD 给改写建议，你逐条采纳后下载投递版。

仓库：[github.com/Tang9526/resume-optimizer](https://github.com/Tang9526/resume-optimizer)

## 解决什么问题

投递时常见两难：通用简历过不了关键词筛选；网上「AI 优化简历」又容易补技能、补数字、补项目。本项目只做一件事——**岗位关键词对齐，且必须忠实于原文**。

- **允许：** 把 JD 里的技能、职责、方法论写进已有句子；同一事实换成更贴岗位的表述。
- **禁止：** 添加事实里没有的技能、证书、职位、项目或数字；把缺口写成已经具备。

## 它实际做什么

1. **导入母版** — 浏览器读取 `.docx`，原文缓存在 IndexedDB，不进项目云端。
2. **事实核验** — 模型只抽可核对事实（经历 / 项目 / 教育 / 技能），默认未确认，需你勾选。
3. **岗位匹配** — 粘贴 JD（至少 30 字），对照已确认事实，输出覆盖项、缺口和摘要。
4. **改写建议** — 最多 5 条；原文必须是连续片段；建议只替换该句。
5. **导出** — 把采纳的句子写回原 Word，下载 `*-投递版.docx`，或按写回后全文打印 PDF。

工作台要三项齐备才生成报告：接口 + 模型 + Key、至少 1 条已确认事实、JD 足够长。报告不会自动跑。

## 隐私与数据

- 无登录、无项目云库。简历、公司、岗位、JD、建议存在浏览器 `localStorage`。
- API Key 只保留在当前标签页（`sessionStorage`），关闭即清除。
- Word 母版缓存在 IndexedDB，用于同一份文件上的句子定位和写回。
- 模型请求经边缘函数 `proxyChat` 转发到你填写的公网 `https` 接口，路径必须是 `/chat/completions`。内网、本机、带账号密码的地址会被拒绝。Key 不写入数据库。

## 技术栈

- 前端：React 18、TypeScript、Vite、Tailwind
- Word：mammoth 抽文本；自研 ZIP / OOXML 写回 `word/document.xml`
- AI：自带 OpenAI 兼容接口（如 DeepSeek）；Deno 边缘函数做 SSE 转发
- 平台：Meoo Cloud（开发端口固定 `3015`，Hash 路由）

## 本地运行

需要 Node.js 与 pnpm。开发服务器必须占用 **3015** 端口。

```bash
pnpm install
pnpm dev
```

浏览器打开提示的本地地址后，进入工作台，填写：

- 接口地址（例如 `https://api.deepseek.com` 或 `https://api.openai.com/v1`）
- 模型名称（文本任务可试 `deepseek-v4-flash`）
- API Key（仅当前标签页有效）

构建：

```bash
pnpm build
```

## 仓库结构

```
src/resume/          工作台、模型调用、Word 写回
functions/proxyChat/ 边缘函数：校验并转发 chat/completions
.cursor/skills/      JD 分析、简历改写、要点写作的约束说明
```

## 原则

先确认事实，再调整表达。模型只重排和改写你已有的信息，不会自动补经历。
