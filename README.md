# GreenMail Manager

GreenMail Manager 是一个面向 GreenMail 开发板的多设备管理平台，提供设备接入、消息采集、短信/通话记录查看、局域网命令下发、推送规则、接口日志追踪和批量操作能力。

项目由两部分组成：
- 后端：Node.js + Express + better-sqlite3
- 前端：React + Vite

默认运行后同时提供：
- Web UI / HTTP API：`3000`
- 设备 TCP 上报端口：`3888`

## 功能概览

- 设备列表与设备详情管理
- 设备自定义名称、管理密码、在线状态展示
- HTTP Webhook 接收设备上报
- TCP 服务接收设备上报
- 自动时间同步响应
- 短信收件箱 / 发件箱分页查询
- 通话事件查看
- 局域网命令下发
- 主动从设备拉取短信
- 批量查询、批量重启、批量发短信
- Bark / 钉钉 / 飞书 / 企业微信 / Telegram / Slack 等推送规则
- 接口日志追踪，便于排查 `invalid payload`、推送失败、设备请求失败
- SQLite 持久化存储

## 目录结构

```text
.
├── client/                  # React 前端
├── server/                  # Node.js 后端
├── data/                    # 默认数据目录，保存 SQLite 数据库
├── deploy/nginx/            # Nginx 反向代理示例
├── docker-compose.yml       # Docker Compose 部署文件
├── Dockerfile               # 多阶段构建镜像
└── AI-API-SPEC-v1.1/        # 设备协议/接口相关参考资料
```

## 运行要求

- Node.js 20+
- npm 10+
- Docker / Docker Compose（如果用容器部署）

## 本地开发

### 1. 安装依赖

根目录安装后端依赖：

```bash
npm install
```

前端目录安装依赖：

```bash
cd client
npm install
cd ..
```

### 2. 启动后端

```bash
npm run dev
```

后端默认监听：
- `http://localhost:3000`
- TCP `0.0.0.0:3888`

### 3. 启动前端开发服务器

```bash
cd client
npm run dev
```

Vite 开发服务器默认会启动在 `http://localhost:5173`，并自动把 `/api` 代理到 `http://localhost:3000`。

### 4. 构建前端

```bash
npm run build:client
```

构建后产物位于：

```text
client/dist
```

后端会直接托管这个目录中的静态文件。

## Docker Compose 部署

项目已经内置可直接使用的 Compose 配置。

### 1. 准备环境变量

```bash
cp .env.example .env
```

`.env.example` 当前包含：

```env
TZ=Asia/Shanghai
APP_PORT=3000
TCP_PORT_PUBLIC=3888
NGINX_HTTP_PORT=80
```

### 2. 启动应用

```bash
docker compose up -d --build
```

启动后：
- Web UI / API：`http://你的服务器IP:3000`
- 设备 TCP 上报：`你的服务器IP:3888`

### 3. 启动带 Nginx 的代理模式

如果你希望由 Nginx 转发 HTTP：

```bash
docker compose --profile proxy up -d --build
```

此时：
- Nginx 监听宿主机 `80`
- 应用容器仍监听 `3000`
- Nginx 配置文件位置：[deploy/nginx/default.conf](/home/h/code/greenmail-manager/deploy/nginx/default.conf)

### 4. 常用命令

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f
```

重建更新：

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## Node 镜像 Compose 部署

如果你希望：

- 不构建项目专用镜像
- 直接把当前代码目录挂进容器
- 容器只提供 Node 运行环境

可以使用 [docker-compose.node.yml](/home/h/code/greenmail-manager/docker-compose.node.yml)。

这个方案的特点是：

- 使用官方 `node:20-bookworm`
- 容器工作目录就是挂载后的项目目录 `/workspace`
- 项目代码、`data/`、配置文件都直接来自宿主机
- 容器启动时会自动安装依赖、构建前端并启动后端

### 启动

```bash
docker compose -f docker-compose.node.yml up -d
```

首次启动会比生产镜像模式慢一些，因为它会在容器里执行：

```bash
npm install
cd client && npm install --include=dev && npm run build
node server/index.js
```

这里显式使用 `npm install --include=dev` 是因为前端构建依赖 `vite`，而该 Compose 环境设置了 `NODE_ENV=production`，普通 `npm install` 会跳过 `client` 下的 devDependencies。

### 查看日志

```bash
docker compose -f docker-compose.node.yml logs -f
```

### 停止

```bash
docker compose -f docker-compose.node.yml down
```

### 端口映射

默认仍然是：

- `${APP_PORT:-3000}:3000`
- `${TCP_PORT_PUBLIC:-3888}:3888`

也就是默认：

- 宿主机 `3000` -> 容器 `3000`
- 宿主机 `3888` -> 容器 `3888`

### 目录与依赖说明

这个 Compose 方案会把整个项目目录挂到容器：

```text
.:/workspace
```

同时为了避免容器里的 `node_modules` 和宿主机目录互相污染，额外使用了两个 named volume：

- `/workspace/node_modules`
- `/workspace/client/node_modules`

数据目录直接使用宿主机项目下的：

```text
./data
```

对应容器内：

```text
/workspace/data
```

### 适用场景

适合：

- 服务器上直接拉代码运行
- 希望“代码即运行目录”
- 只想把 Docker 当作 Node 运行环境

不太适合：

- 追求最快启动速度
- 追求最小运行镜像
- 严格生产隔离场景

## PM2 部署

如果你不使用 Docker，也可以直接用 PM2 托管后端进程。

### 1. 安装依赖并构建前端

```bash
npm install
cd client
npm install
npm run build
cd ..
```

说明：
- 后端进程会直接托管 `client/dist`
- 所以 PM2 部署前要先完成前端构建

### 2. 安装 PM2

```bash
npm install -g pm2
```

### 3. 使用内置配置启动

项目已提供 [ecosystem.config.js](/home/h/code/greenmail-manager/ecosystem.config.js)：

```bash
pm2 start ecosystem.config.js
```

查看状态：

```bash
pm2 status
```

查看日志：

```bash
pm2 logs greenmail-manager
```

重启：

```bash
pm2 restart greenmail-manager
```

停止：

```bash
pm2 stop greenmail-manager
```

删除：

```bash
pm2 delete greenmail-manager
```

### 4. 开机自启

保存当前进程列表：

```bash
pm2 save
```

生成 systemd 自启动命令：

```bash
pm2 startup
```

按 PM2 输出的提示执行对应命令后，再执行一次：

```bash
pm2 save
```

### 5. 常见调整

如果你要修改端口或数据目录，可以直接改 [ecosystem.config.js](/home/h/code/greenmail-manager/ecosystem.config.js) 里的：

- `PORT`
- `TCP_PORT`
- `DATA_DIR`
- `TZ`

默认值：

```js
PORT: 3000
TCP_PORT: 3888
DATA_DIR: './data'
TZ: 'Asia/Shanghai'
```

### 6. 反向代理建议

如果你用 PM2 跑生产环境，建议：

- 应用监听内网端口，例如 `3000`
- Nginx / Caddy 反向代理到 `3000`
- 设备 TCP 上报端口 `3888` 直接对外放行

HTTP 访问：

```text
http://<服务器IP>:3000
```

设备 TCP 上报：

```text
<服务器IP>:3888
```

## 数据持久化

当前 Compose 已配置为宿主机目录持久化：

```yaml
volumes:
  - ./data:/data
```

容器内数据库路径：

```text
/data/greenmail.db
```

宿主机数据库路径：

```text
./data/greenmail.db
```

## 环境变量

后端支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `TCP_PORT` | `3888` | 设备 TCP 上报端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `PING_POLL_INTERVAL` | `30000` | 管理端主动 ping 设备的轮询间隔，单位毫秒 |
| `TZ` | `Asia/Shanghai` | 容器时区 |

## 接入方式

### 1. 设备通过 HTTP Webhook 上报

接口：

```text
GET  /api/webhook
POST /api/webhook
```

支持：
- GET + query 参数
- GET + `p=` JSON
- GET + `p=` key-value 字符串
- POST + JSON
- POST + form-urlencoded

`type=100` 时，服务端会按协议返回 14 位时间字符串，用于设备时间同步。

### 2. 设备通过 TCP 上报

TCP 服务默认端口：

```text
3888
```

消息按 `0x11 0x12` 分隔，服务端会解析 JSON，并在 `type=100` 时按协议回发时间同步数据。

### 3. 管理端主动访问设备

系统支持通过设备局域网 IP 调用设备 `/ctrl` 接口执行：
- `stat`
- `ping`
- 发短信
- 重启
- 其他命令下发

新增设备时如果只填 `wifi_ip`，系统会尝试调用：

```text
http://<设备IP>/ctrl?token=<token>&cmd=stat
```

自动获取 `dev_id` 和部分设备信息。

## 主要页面

- `/`：仪表盘
- `/devices`：设备列表
- `/devices/:devId`：设备详情
- `/messages`：所有消息
- `/sms`：短信收发
- `/calls`：通话事件
- `/push-rules`：推送规则
- `/interface-logs`：接口日志

## 主要 API

### 健康检查

```text
GET /api/health
```

### 设备

```text
GET    /api/devices
GET    /api/devices/:devId
POST   /api/devices
PUT    /api/devices/:devId
DELETE /api/devices/:devId
```

### 消息

```text
GET /api/messages
GET /api/messages/export
GET /api/messages/stats
```

### 推送规则

```text
GET    /api/push-rules
POST   /api/push-rules
PUT    /api/push-rules/:id
DELETE /api/push-rules/:id
POST   /api/push-rules/:id/test
GET    /api/push-rules/:id/logs
```

### 接口日志

```text
GET    /api/interface-logs
DELETE /api/interface-logs
```

### 批量操作

```text
POST /api/batch/execute
```

### 设备主动拉取短信

```text
POST /api/devices/:devId/enable-sms-storage
POST /api/devices/:devId/sync-sms
```

## 推送规则模板变量

当前推送模板支持：

- `{{dev_id}}`
- `{{device_name}}`
- `{{device_label}}`
- `{{event_label}}`
- `{{type}}`
- `{{slot}}`
- `{{phone}}`
- `{{msIsdn}}`
- `{{content}}`
- `{{received_at}}`
- `{{raw_json}}`

说明：

- `{{device_name}}`：设备自定义名称
- `{{device_label}}`：优先输出 `设备名 (SN)`，没有设备名时直接输出 `SN`
- `{{event_label}}`：事件文案，例如：
  - `新短信`
  - `短信已发送`
  - `来电振铃`
  - `来电接通`
  - `来电挂断`
  - `去电拨号`
  - `去电振铃`
  - `去电接通`
  - `去电挂断`
- `{{msIsdn}}`：设备上报中的 SIM 卡号码（未上报时为空）

推送规则过滤字段：

- `trigger_types`：按消息类型过滤
- `trigger_devices`：按设备 SN 过滤
- `trigger_msisdn`：按号码过滤（逗号分隔，支持 `+8613...` 或纯数字写法）

推荐 Bark 模板：

```json
{
  "device_key": "YOUR_KEY",
  "title": "{{device_label}}",
  "body": "{{event_label}}\n{{phone}}: {{content}}",
  "group": "GreenMail"
}
```

## 设备配置建议

部署完成后，通常需要确认以下配置：

- 设备上报目标 HTTP 地址是否指向：

```text
http://<服务地址>:3000/api/webhook
```

- 或设备 TCP 上报目标是否指向：

```text
<服务地址>:3888
```

- 如果通过公网接入，确认防火墙 / 安全组已放行：
  - `3000`
  - `3888`
  - `80`（如果启用了 Nginx）

## 故障排查

### 1. `invalid payload`

先检查：
- 设备是否把消息发到了 `/api/webhook`
- 请求格式是否为 JSON / FORM / `p=` 包裹格式之一
- `devId` / `deviceId` / `dev_id` 是否带上了设备标识

可以到接口日志页面查看最近请求：

```text
/interface-logs
```

### 2. Bark 推送失败

建议先在页面里点“测试”，再查看：
- 实际请求 URL
- 错误信息是否包含 `ENOTFOUND` / `ECONNRESET` / `ETIMEDOUT`

如果使用旧格式 Bark URL，例如：

```text
https://api.day.app/<device_key>/
```

系统会自动兼容转换到官方 `/push` JSON 形式。

### 3. 页面修改了但看起来没生效

通常是旧前端资源或旧后端进程仍在运行：

- 容器部署：重新 `docker compose up -d --build`
- 本地部署：重启后端，浏览器强制刷新

### 4. 设备显示离线

检查：
- 设备最近是否还在上报
- 管理端是否能访问设备 `wifi_ip`
- `3888` / `3000` 端口是否被阻断

## 备注

- 数据库存储为 SQLite，默认文件：`data/greenmail.db`
- 前端构建产物由后端直接托管
- 当前项目默认无登录鉴权，生产环境建议至少放到内网或配反向代理访问控制
