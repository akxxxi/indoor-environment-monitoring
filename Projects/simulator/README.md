# 虚拟上传节点

已实现单设备 Node.js ESM MVP：每 2000 ms 生成温度、湿度、CO₂、GP2Y1010 粉尘浓度估算值和光照，先存本地 SQLite，再经 MQTT 上传。所有采样 `source: simulator`，没有 PM2.5 字段。运行需要 Node.js 24.15.x、npm 11.x；SQLite 使用 Node 内置 `node:sqlite`，运行依赖只有 `mqtt`。

## 安装与运行（PowerShell）

```powershell
Set-Location D:\00_Graduation_Project\Projects\simulator
npm install
Copy-Item .env.example .env
npm run dev
```

已有 `.env` 时保留自己的配置，不要再次覆盖。`npm start` 与 `npm run dev` 使用相同入口，均自动读取 `.env`；已有系统/PowerShell 环境变量优先于 `.env`。Ctrl+C 正常退出会停止采样、尽可能发布 offline、关闭 MQTT 和数据库，尚未确认的数据保留。

默认连接 `mqtt://127.0.0.1:1883`，设备 `classroom-001-node-001`，教室 `classroom-001`。后端未启动也可以运行，日志会显示连接失败与重连，队列每两秒新增一条；不会伪造成功确认。依赖、锁文件和 npm 缓存都在本目录，`.npmrc` 指向 npm 官方源。

## 四种情景

停止上一次进程后，在同一终端执行对应命令。也可以直接修改 `.env` 中的 `SIMULATION_SCENARIO`。

```powershell
# 正常值
$env:SIMULATION_SCENARIO = 'normal'
npm run dev

# demo：正常 → CO₂/粉尘超限 → 恢复，重复循环
$env:SIMULATION_SCENARIO = 'demo'
npm run dev

# 持续 CO₂ 升高
$env:SIMULATION_SCENARIO = 'co2_high'
npm run dev

# 持续粉尘升高
$env:SIMULATION_SCENARIO = 'dust_high'
npm run dev
```

每次只运行一个节点进程。`demo` 一轮 40 次采样：正常 10 次、升高 15 次、恢复 15 次，默认约 80 秒。数值逐步靠近目标，升高阶段 CO₂ 约 1450 ppm、粉尘约 180 μg/m³，恢复阶段约 700 ppm、28 μg/m³，足够演示共用默认阈值的连续三次触发与迟滞恢复。具体报警由后端计算。改变上传周期会同比改变演示时长；队列满载时暂停采样及情景推进。

固定 `SIMULATION_SEED` 会复现相同情景的测量趋势。采样时间始终使用实际 UTC 时间；`boot_id` 由密码学随机数独立生成，每次进程启动不同。`co2_high` 和 `dust_high` 也从正常值平滑升高。恢复使用 `demo` 的恢复阶段，或重启为 `normal`。仅支持上述四种情景。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| MQTT_URL | mqtt://127.0.0.1:1883 | MQTT Broker |
| DEVICE_ID | classroom-001-node-001 | 必须与后端登记一致 |
| ROOM_ID | classroom-001 | 必须与后端教室归属一致 |
| UPLOAD_INTERVAL_MS | 2000 | 采样周期，最小 50 ms；演示保持默认 |
| SIMULATION_SEED | 20261016 | 固定测量趋势，不控制标识或时间 |
| SIMULATION_SCENARIO | normal | normal / co2_high / dust_high / demo |
| QUEUE_DB_PATH | ./data/outbox.sqlite | 相对路径以 simulator 项目目录解析 |
| QUEUE_MAX_RECORDS | 43200 | 待发记录容量，默认约 24 小时 |
| ACK_TIMEOUT_MS | 10000 | 应用确认等待时长 |
| RETRY_BASE_MS | 1000 | 超时后额外等待，指数退避至最多 30 秒 |
| MQTT_RECONNECT_MS | 2000 | 断线后的重连间隔 |

切换回 `.env` 配置可执行 `Remove-Item Env:SIMULATION_SCENARIO -ErrorAction SilentlyContinue`。有旧待发记录时更改设备/教室会明确报错，避免订阅新设备 ACK 却堵住旧队列；应使用原身份排空，或为新身份指定新的队列路径。

## 持久队列与确认

- 直接读取 `../../Docs/contracts/telemetry.schema.json` 校验生成的数据，并检查 1024 字节上限。MQTT 3.1.1、QoS 1，telemetry 和 ACK 均非 retained。
- 主题为 `envmon/v1/devices/{device_id}/telemetry`、`ack`、`status`。每次连接先等待 ACK 主题的 QoS 1 SUBACK，再发送 online 状态和队列数据。连接使用全新 MQTT 客户端，避免库自动重放先于订阅。
- SQLite 使用 WAL 与 FULL 同步。先入队再发送，以自增 ID 保证生成顺序；每次仅有一条逻辑消息等待应用 ACK。记录尝试次数和最近尝试时间。
- PUBACK 不出队。仅匹配 `(device_id, boot_id, seq)` 的完整 `stored` / `duplicate` 应用 ACK 删除记录；未匹配、格式不完整、retained 或重复确认均不改变待发数据。
- ACK 超时使用相同原文重发。断线继续入队，恢复订阅后先补旧记录；每收到一条应用 ACK 立即发送下一条，不等待采样周期。
- 永久 `rejected` 记录转为本表 `state='rejected'`，保留 payload、错误代码、错误说明和拒收时间，后续消息继续发送。临时故障无成功 ACK 时继续保留与重试。
- 满 43,200 条时打印明确提示并暂停接纳新采样，不覆盖历史；确认出队后自动恢复。拒收记录不计入待发容量，不自动清理。
- status 为 QoS 1 retained，连接后发布 online，遗嘱为 offline。状态只用于连接提示，不能替代后端的数据新鲜度判断。

查看队列（可在另一个终端运行）：

```powershell
npm run queue
```

输出数据库绝对路径、待发数量、队首原文/尝试次数、拒收总数和最近 10 条拒收原因。它不会删除队列。

## 断线、重启与报警演示

1. 由后端项目负责人启动后端及其内嵌 Broker；本节点不启动其他项目。在本目录以 `normal` 或 `demo` 运行 `npm run dev`，观察“ACK 订阅成功”“入库确认”以及 `queue=0`。
2. 停止后端，保持节点运行至少 10 秒。观察重连日志和持续增长的队列，使用 `npm run queue` 查看队首原始时间与 boot_id。
3. 重启后端。节点重连后重新订阅 ACK，按序补传，队列快速回到零。旧消息的 boot_id、seq、sampled_at 不变；历史补传是否影响最新值/报警由后端按契约处理。
4. 再停止后端，积累几条后 Ctrl+C 停止节点；重新 `npm run dev`。启动日志应显示旧队列数量，新采样生成新的 boot_id；重启后端后先补旧批次，再传新批次。
5. 后端正常时切为 `demo`，观察约 80 秒的正常、触发与恢复循环。若之前有积压，先排空，以免历史补传混入演示观察。

## 自动验证

```powershell
npm test
npm run verify:restart
npm run verify:mqtt
```

`npm test` 的 4 项测试覆盖：SQLite 重开及容量、ACK 匹配/重复确认、永久拒收移出待发、固定种子与 demo 趋势、SUBACK 发送门控、PUBACK 不出队、超时重发和快速排空。

`verify:restart` 启动真实子进程，离线按 2 秒周期采样 3 条后强制终止；重启后验证原 3 条完整 payload 逐字保留、新 boot_id 独立、队列为 4 条，并验证正常退出。

`verify:mqtt` 约需 24 秒，仅在 127.0.0.1 随机端口启动一个测试用 MQTT 报文对端。它验证默认 2 秒周期连续上传 10 条、丢失应用 ACK 后获取 duplicate、重复 ACK、断线继续采样、按序快速补传、online/offline 和遗嘱配置。测试对端没有业务数据库，不是项目后端，不占用 1883。临时测试数据库结束后删除；默认 outbox 不受影响。若运行环境禁止本机 TCP，需允许该测试的 loopback 连接。

本轮验证记录（2026-10-16）：

- `npm install` 成功，依赖与锁文件已保存；审计 0 个漏洞。
- `npm run dev` 已实际执行，默认离线生成 7 条，Ctrl+C 正常退出并保留队列。
- `npm test`：4/4 通过。
- `npm run verify:restart`：强制终止/进程重启保留、同种子新 boot_id、正常关闭全部通过。
- `npm run verify:mqtt`：真实 TCP/MQTT 对端收到 13 条唯一消息、14 次到达；连续 10 条成功、丢 ACK 重试、重复 ACK、断线积累 2 条后按序排空全部通过。沙箱限制解除后完成本机 TCP 验证。
- 后续已完成真实项目后端与网页联调：入库 ACK、丢 ACK 后 duplicate 与唯一行数、断线采样、强制重启后原文补传、网页报警触发/恢复均通过，见 [验收记录](../../Docs/三端联调验收记录.md)。节点入口支持启动器 IPC 停止与失联清理；根目录双击 `start.cmd` 即可运行完整系统。真实遗嘱单独投递仍未在整体脚本中断言，后端在线状态同时依据真实连接断开处理。

## 文件与限制

`src/generator.js` 负责测量趋势，`src/outbox.js` 负责 SQLite，`src/node.js` 负责 MQTT 与确认状态，`src/index.js` 为入口。`scripts/` 提供查看队列和独立验收脚本，测试对端仅用于验证。

这是单进程、单设备 MVP；同一个 outbox 不能被两个上传进程同时消费。拒收记录会持续保留，需要人工查看；没有自动重放拒收或清理历史的管理功能。固定种子只保证相同版本/情景下的测量趋势复现，进程重启会从趋势起点开始。传感器阈值和曲线属于工程演示值，不声明为测量标准。不包含硬件、串口、Web 控制台、后端替代实现或批量造数。
