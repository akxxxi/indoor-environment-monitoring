# 本地后端 MVP

已实现一个 Node.js 进程内的 Express HTTP、Aedes MQTT 3.1.1 和 SQLite 持久化。默认只监听 `127.0.0.1`：HTTP `3000`，MQTT `1883`。仅实现本轮共用约定中的接口。

## 安装与启动

环境：Windows PowerShell，Node.js **24.15.0**，npm **11.12.1**。使用内置 `node:sqlite`，无需安装 SQLite 驱动或 ORM。

```powershell
Set-Location D:\00_Graduation_Project\Projects\server
npm install
# 首次需要自定义配置时复制；已有 .env 时直接编辑它
Copy-Item .env.example .env
npm run dev
```

`npm run dev` 使用 Node watch 自动重启；常规运行使用 `npm start`。两者均读取可选的 `.env`，未创建时使用默认值。启动自动建表、登记默认教室和设备，并写入默认阈值。已有数据库和阈值不会被默认配置覆盖。Ctrl+C 正常关闭 HTTP、MQTT、SSE、定时器和数据库。

依赖及锁文件只在本目录；`.npmrc` 固定精确版本、使用官方 npm registry，并把缓存放在本项目 `.npm-cache`。正式数据默认写入 `data/environment.sqlite`，原始记录不自动删除。备份运行中的数据库时需处理 WAL，最简单的本地备份方式是先正常停止服务，再复制数据库文件。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| HTTP_HOST / HTTP_PORT | 127.0.0.1 / 3000 | HTTP 地址 |
| MQTT_HOST / MQTT_PORT | 127.0.0.1 / 1883 | MQTT TCP 地址 |
| SQLITE_PATH | ./data/environment.sqlite | 相对 server 目录解析 |
| DEFAULT_ROOM_ID | classroom-001 | 默认教室登记 |
| DEFAULT_DEVICE_ID | classroom-001-node-001 | 默认设备登记 |
| MQTT_MAX_PAYLOAD_BYTES | 1024 | 可调小，不可超过协议上限 |
| DEVICE_STALE_AFTER_MS | 10000 | 采样过期时间，也用于报警新鲜度 |
| SSE_HEARTBEAT_MS | 15000 | SSE 注释心跳间隔 |
| CORS_ORIGIN | http://127.0.0.1:5173 | 允许网页跨域 GET/PUT/SSE 的来源 |

已有设备的教室归属和配置不符会明确启动失败，避免悄悄迁移设备。端口 `0` 仅用于测试分配临时端口。默认前端来源使用 `127.0.0.1`；使用 `localhost` 打开网页时须相应修改 `CORS_ORIGIN`。

## 最短 MQTT / HTTP 验证

保持服务运行，在另一个 PowerShell 终端执行：

```powershell
Set-Location D:\00_Graduation_Project\Projects\server
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health | ConvertTo-Json
npm run verify:mqtt
Invoke-RestMethod http://127.0.0.1:3000/api/v1/devices/classroom-001-node-001/latest | ConvertTo-Json -Depth 8
```

`verify:mqtt` 是一次性的测试客户端，连接实际 MQTT 端口，以 QoS 1、retain false 上传一条使用当前时间和随机 boot_id 的虚拟测试记录，再验证 duplicate、MESSAGE_CONFLICT 和 HTTP 查询。**每次运行会在当前配置数据库中留下 1 条测试记录**，不会自动清理。它不是持续采样 simulator。可通过 `HTTP_URL`、`MQTT_URL`、`DEFAULT_DEVICE_ID`、`DEFAULT_ROOM_ID` 环境变量指向其他配置。

若只做验证且不想写正式数据，在启动服务的终端先设置：

```powershell
$env:SQLITE_PATH = './.test-data/manual/test.sqlite'
npm run dev
```

查看事件时先运行以下命令，然后在另一个终端执行 `npm run verify:mqtt`：

```powershell
curl.exe -N "http://127.0.0.1:3000/api/v1/events?device_id=classroom-001-node-001"
```

会看到 `measurement.created`、`device.updated` 等命名事件，以及约 15 秒一次的 `: heartbeat`。关闭 curl 会清理订阅。修改阈值示例：

```powershell
$uri = 'http://127.0.0.1:3000/api/v1/devices/classroom-001-node-001/thresholds'
$config = (Invoke-RestMethod $uri).data
$config.PSObject.Properties.Remove('version')
$config.rules.co2_ppm.upper = 1200
$body = $config | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Put -Uri $uri -ContentType 'application/json' -Body $body
```

PUT 为完整替换配置，请包含五项规则并去掉 version；服务端在事务内递增版本。示例会持久修改阈值，可按同样方法改回 1000。

## 接口

成功使用 `{data: ...}`，错误使用 `{error: {code, message}}`，时间统一输出 UTC。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/v1/health | 检查 MQTT 监听、broker 和数据库；已观察到的写入故障也返回 503，直到成功写入重试；失败遵循统一 error 格式 |
| GET /api/v1/devices/:id/latest | 全部 telemetry 字段加记录时间、在线/过期状态和当前活动报警；无数据为 data:null |
| GET /api/v1/devices/:id/series | metric、start、end、max_points；SQL 时间桶均值，忽略 null，返回 count |
| GET /api/v1/devices/:id/thresholds | 持久阈值及 version |
| PUT /api/v1/devices/:id/thresholds | 校验、事务保存、增加版本，发 thresholds.updated |
| GET /api/v1/events?device_id=:id | measurement.created、device.updated、alarm.changed、thresholds.updated |

未知设备返回 404；非法时间、范围、指标、阈值或正文返回 400；数据库/依赖不可用返回 503。曲线默认最近 1 小时、co2_ppm、max_points=600；单次范围最多 7 天，max_points 为 1..1200。区间为 `[start, end)`，输入时间必须是带时区的 RFC 3339，输出按 UTC 时间升序。

桶相对查询 start 对齐，最小宽度为 2 秒，按 max_points 自动加宽，最多返回所请求的点数。没有记录的桶省略；有记录但该指标全 null 的桶返回 `value:null,count:0`。采样时间未知的记录不进入曲线。

## 数据、确认与报警语义

- 运行时直接读取 `../../Docs/contracts/telemetry.schema.json`，使用 Ajv 2020 和 ajv-formats。额外校验 UTF-8、最多 1024 字节、QoS 1、非 retained、主题设备 ID、登记教室及时间。拒收比服务端超前超过 5 秒的采样，允许历史补传。不对 Schema 未规定范围的温度擅自加上下限；所有数值必须有限。
- telemetry / ack / status 主题为 `envmon/v1/devices/{device_id}/{telemetry|ack|status}`。仅后端发布应用 ACK；上传端向其他主题发布会被 broker 关闭连接。ACK 为直接 JSON，无 HTTP data 包装，QoS 1、retain false。
- `(device_id,boot_id,seq)` 唯一；完整业务 JSON 递归排序键后比较，忽略空白和键顺序。相同内容 duplicate 使用原 stored_at；同标识不同内容为 MESSAGE_CONFLICT，不覆盖记录。
- 只有 SQLite COMMIT 成功后才发送 stored/duplicate。永久拒绝且能读取完整标识时发送 rejected；不能解析、超过字节预算或缺完整标识时只记录诊断，不解析超大正文来提取 ACK 标识。数据库临时故障既不发成功，也不发永久拒绝，上传端应保留待发记录并重试。MQTT PUBACK 只代表传输接收。
- retained telemetry 在入库前拒收，并取消其 broker retain 标记，避免成为后续 retained 重放数据。status 可 retained；服务端只把当前真实连接发来的合法 status 当作提示，不会因订阅时重放的旧 online 判在线。
- 最新记录以 `effective_at` 降序、id 降序选择；已知时间的 effective_at 为 sampled_at，未知时为 received_at 并标记 received_only。旧补传不会覆盖较新的快照；同一有效时刻的新记录以较大 id 展示，但不再次累计报警。
- 在线状态依据当前登记设备对应的 MQTT 连接、合法 status 或成功接收的 telemetry；连接断开即移除相应在线来源。任意 clientId 在合法上传/status 后可关联设备。last_seen_at 是本次运行最近观察到的消息时间，重启初值来自最近入库接收时间。online 和 stale 分开计算：在线也可以过期；未知时间不会被当成新鲜设备采样。
- `measurement.created` 仅首次提交后发送，历史补传也发送；duplicate 不重复发测量事件。SSE 无持久重放，断线后先订阅再查询 latest/series；慢客户端会被断开，需重新同步。
- 工程演示阈值与共用约定一致：温度 16..30、湿度 30..70、CO₂ 上限 1000、粉尘估算值上限 100、光照下限 200；迟滞分别为 1、3、100、10、20，连续次数为 3。**这些是工程演示配置，不声明为国家标准。**
- 仅比快照更新、采样时间已知且新鲜的有效记录参与报警。连续超上/下界触发；高报警回落至 upper-hysteresis、低报警回升至 lower+hysteresis，且未越过另一侧告警界限，连续满足次数后恢复。null 不代表正常，会中断对应指标的未完成计数，保留活动报警。超过新鲜度的采样间隔清空未完成计数。
- 修改规则清空未完成计数，活动报警保留并从后续新鲜有效采样按新规则判断恢复。禁用规则也在后续有效采样达到连续次数后解除，不伪造恢复采样。过期/离线本身不会把报警清成正常。

## 实际响应样例

以下来自默认端口的真实 `npm run dev` + `npm run verify:mqtt` 验证，时间是该次采样时间，不是运行时常量。

健康检查：

```json
{"data":{"status":"ok","mqtt":true,"database":true}}
```

首次、重复、冲突 ACK（每行为一个独立 JSON 消息）：

```json
{"schema_version":1,"device_id":"classroom-001-node-001","boot_id":"768ce51c91b105c0","seq":1,"status":"stored","stored_at":"2026-10-16T15:09:53.907Z"}
{"schema_version":1,"device_id":"classroom-001-node-001","boot_id":"768ce51c91b105c0","seq":1,"status":"duplicate","stored_at":"2026-10-16T15:09:53.907Z"}
{"schema_version":1,"device_id":"classroom-001-node-001","boot_id":"768ce51c91b105c0","seq":1,"status":"rejected","error":{"code":"MESSAGE_CONFLICT","message":"Message identity already exists with different content"}}
```

latest 完整快照：

```json
{
  "data": {
    "boot_id": "768ce51c91b105c0",
    "device_id": "classroom-001-node-001",
    "metrics": {"co2_ppm":720,"dust_ug_m3":28,"humidity_rh":48.2,"illuminance_lux":430,"temperature_c":24.6},
    "room_id": "classroom-001",
    "sampled_at": "2026-10-16T15:09:53.801Z",
    "schema_version": 1,
    "seq": 1,
    "source": "simulator",
    "id": 1,
    "received_at": "2026-10-16T15:09:53.906Z",
    "stored_at": "2026-10-16T15:09:53.907Z",
    "effective_at": "2026-10-16T15:09:53.801Z",
    "time_quality": "device",
    "device": {"online":true,"stale":false,"last_seen_at":"2026-10-16T15:09:53.911Z"},
    "alarms": []
  }
}
```

series 响应：

```json
{"data":[{"time":"2026-10-16T15:09:52.801Z","value":720,"count":1}],"meta":{"metric":"co2_ppm","bucket_seconds":2,"start":"2026-10-16T15:09:52.801Z","end":"2026-10-16T15:09:54.801Z"}}
```

thresholds 响应：

```json
{"data":{"version":1,"consecutive_samples":3,"rules":{"temperature_c":{"enabled":true,"lower":16,"upper":30,"hysteresis":1},"humidity_rh":{"enabled":true,"lower":30,"upper":70,"hysteresis":3},"co2_ppm":{"enabled":true,"lower":null,"upper":1000,"hysteresis":100},"dust_ug_m3":{"enabled":true,"lower":null,"upper":100,"hysteresis":10},"illuminance_lux":{"enabled":true,"lower":200,"upper":null,"hysteresis":20}}}}
```

SSE 的 measurement.created 正文是同一已提交快照去掉 device、alarms 及外层 data。其他事件的正文遵循共用约定。

## 自动验证

```powershell
Set-Location D:\00_Graduation_Project\Projects\server
npm test
```

`node:test` 使用 `127.0.0.1` 临时端口和 `.test-data/run-*` 临时数据库，关闭连接后清理，不污染 `data/environment.sqlite`。必须允许本机回环网络连接。在受限执行沙箱中出现 `connect EACCES` 时需允许测试进程访问自己的本机端口。

已通过 17 项测试（含集成子测试），覆盖：

- 规范化去重、内容冲突、重启历史/阈值/原 stored_at 保留。
- 实际 SQLite 延迟外键约束造成 **COMMIT 失败**：回滚零记录、无应用 ACK、无测量 SSE，健康检查 503；去除临时触发器后重试成功。故障只在测试数据库注入，没有生产故障接口。
- 真实 MQTT 入库，schema/归属/时间/QoS/retain 校验，畸形 UTF-8/JSON/超大正文不拖垮服务。
- latest 不被旧补传覆盖、unknown 时间标记、在线与过期独立。
- SQL 桶均值、null、左右边界、点数及 7 天限制。
- 报警连续次数、上下界迟滞、缺测、跨越另一边界、规则更新、新鲜度间隔。
- 四类 SSE 事件、心跳、断开清理、关闭含活动 SSE 和未发送 CONNECT 的 MQTT socket。
- HTTP 端口占用时回滚已启动的 MQTT/数据库资源。

另已实际执行 `npm install`、`npm run dev`、`npm run verify:mqtt`，验证默认 `3000/1883` 端口并通过 Ctrl+C 正常退出。该次独立验证数据库留在 `.test-data/dev-smoke/test.sqlite` 供核查，未写入正式演示库。

## 常见启动问题与本轮限制

- `EADDRINUSE`：用 `Get-NetTCPConnection -LocalPort 3000,1883 -ErrorAction SilentlyContinue` 查占用，再用 `Get-Process -Id <OwningProcess>` 确认归属。自行关闭自己的旧服务，或修改 `.env` 端口；不要直接终止不明进程。启动部分失败会清理已创建资源。
- `EACCES`：检查端口保留、防火墙或执行沙箱的本机网络权限；可换本机高位端口验证。
- 数据库无法写入/目录无权限/磁盘满：检查 `SQLITE_PATH` 与可写磁盘。写入失败只记录日志，不确认入库；修复后等待设备重试。SQLite 锁等待最多约 1 秒。
- Node 版本不符或找不到 `node:sqlite`：切回本机 24.15.0，无需安装第三方 sqlite 驱动。npm 网络失败时检查网络；项目使用官方 registry。
- 本轮无用户账号、设备凭据、云部署或管理后台，默认仅本机服务。Aedes 会话/retained 状态在内存中，重启后上传端必须重连并重发待确认数据。
- 报警状态和连续计数在内存；重启后从后续采样重新计算，活动报警也不会从历史重建。没有报警历史中心。
- 无 rooms/devices 管理、原始分页、报警分页、自动删库、无限历史统计或 SSE 永久事件日志。完整协议草案中这些后续规划不属于本轮，共用约定优先；共用文件未修改。
- 上述为独立后端开发时的验证范围；后续整体联调已验证 simulator 应用 ACK/outbox 重试与重启补传、web REST/SSE 重连和阈值 PUT，见 [验收记录](../../Docs/三端联调验收记录.md)。根目录 `start.cmd` 启动完整系统，后端入口支持启动器 IPC 正常停止。

## 依赖依据与源码结构

精确锁定 Express 5.3.0、Aedes 1.2.0、Ajv 8.20.0、ajv-formats 3.0.1；测试客户端 MQTT.js 5.16.1 为 devDependency。版本及 engines 已通过官方 npm registry 核对，安装审计为 0 个漏洞。

实现前核对了 [Node 24.15.0 SQLite](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)、[Express 5 安装要求](https://expressjs.com/en/guide/migrating-5/)、[Aedes API](https://github.com/moscajs/aedes/blob/main/docs/Aedes.md)、[Ajv 2020 Schema 支持](https://ajv.js.org/json-schema.html)、[Ajv formats](https://ajv.js.org/guide/formats.html) 和 [MQTT.js](https://github.com/mqttjs/MQTT.js)。Aedes 使用 1.x 的 `Aedes.createBroker()` 异步初始化。

`src/index.js` 为入口，`app.js` 管理启动/关闭，`mqtt.js` 为接入，`db.js` 为 SQL/事务，`service.js` 合并设备快照与状态，`alarms.js` 处理报警，`http.js`/`events.js` 提供 REST/SSE，`validation.js`/`config.js` 定义校验与本地配置。无通用迁移、注入或插件框架。
