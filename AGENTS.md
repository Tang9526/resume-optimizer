# Meoo 项目约束

本文件定义了 AI 编码助手在本项目中必须遵循的规范。

## 运行环境

- 平台: Meoo Cloud（基于 Supabase 的 BaaS 服务）
- 包管理器: pnpm
- 模板: react-vite-project

## 端口约束

- 开发服务器 **必须** 运行在 **3015** 端口
- 这是沙箱/预览环境唯一对外暴露的端口，**禁止修改**
- 所有模板已预配置 `port: 3015` + `strictPort: true`

## 构建约束

- 构建产物目录: `dist/`
- 入口文件: `dist/index.html`
- 小于 1MB 的图片/字体会被内联为 dataURL
- base 路径使用相对路径 `./`

## 图片引用

- 本地图片 **必须** 放在 `src/assets/` 目录下，通过以下两种方式引用:
  - ES6 import（静态）: `import hero from "@/assets/hero.png"` → `<img src={hero} />`
  - `new URL` + `import.meta.url`（支持动态路径）: `<img src={new URL('/assets/hero.png', import.meta.url).href} />`
- **禁止** 使用 base64 图片或创建二进制文件
- **禁止** 在 `<img src>` 或 CSS `url()` 中使用本地文件系统路径

## 后端服务

- **禁止** 启动后端服务器（Express、Koa、FastAPI 等）
- 使用 Meoo Cloud 代替：
  - PostgreSQL 数据库: `meoo db query`
  - 边缘函数: `meoo fn deploy`
  - 环境变量: `meoo secrets set`
  - 用户认证 + 文件存储: 通过 @supabase/supabase-js

## 技术栈限制

- 不支持: Angular, Svelte, Next.js, 原生移动端
- 路由模式: 使用 Hash 路由（`createHashRouter`）
- 图标: 使用 lucide-react 或内联 SVG，**禁止** @iconify/react
