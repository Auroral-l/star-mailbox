# ❤️ 星空信箱 · Star Mailbox

一个浪漫的写信小网站：

- **💗 爱心** = 写一封信（标题、内容、署名，寄进信箱）
- **⭐ 星星** = 读信与回信（看信箱里所有信，可以回复）

## 功能
- 可以写很多封信，也可以给每封信回复
- 数据自动保存，退出网站、关机、下次再来，信都还在
- 手机、电脑都能打开，数据完全同步
- 零依赖（只用 Node 自带模块），一个命令即可运行

## 本机运行（电脑上用）
```bash
npm start
# 或
node server.js
```
然后浏览器打开 `http://localhost:3000`
（手机连同一个 WiFi，输入屏幕上显示的地址也可以打开）

## 部署到云端（手机随时随地都能打开）
数据有两种保存方式：

1. **本机模式（默认）**：数据保存在服务器磁盘的 `data.json` 里。
2. **云端模式**：设置两个环境变量后，数据自动保存到 GitHub 仓库，永久保留：
   - `GITHUB_REPO`：例如 `myname/star-mailbox`
   - `GITHUB_TOKEN`：GitHub 个人访问令牌（需对该仓库有 Contents 读写权限）

建议部署到 [Render](https://render.com)（免费）等支持 Node 的平台。
部署时把上面两个环境变量填进去即可。

## 接口
- `GET  /api/info` 返回本机地址信息
- `GET  /api/letters` 列出所有信
- `POST /api/letters` 写一封信 `{title, content, sender, recipient}`
- `POST /api/letters/:id/reply` 回复一封信 `{name, content}`

## 项目结构
```
star-mailbox/
├── server.js        # 服务器（零依赖）
├── public/
│   └── index.html   # 网站前端（单文件）
├── start.bat        # Windows 双击启动
└── package.json
```
