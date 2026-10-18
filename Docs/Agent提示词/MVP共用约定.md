# 三个 Agent 的基础 MVP 共用约定

本文件配合三份任务提示词使用，细化本轮联调必需的返回格式。完整规划仍见上级计划书；本轮只完成基础闭环，不要求把完整计划一次做完。本文不表示接口已经实现。

## 项目范围

- 当前 Windows 电脑，Node.js 24.15.0、npm 11.12.1，JavaScript ESM，三个独立 npm 项目。
- simulator、server、web 三个项目，一个教室、一个设备，每 2000 ms 上传。
- 默认设备 `classroom-001-node-001`，教室 `classroom-001`。
- MQTT `mqtt://127.0.0.1:1883`，HTTP `http://127.0.0.1:3000`，网页 `http://127.0.0.1:5173`。
- 数据源为虚拟节点，网页显式标记虚拟数据。不做 MCU、ESP8266 固件或账号登录。
- 五项指标严格使用 `temperature_c`、`humidity_rh`、`co2_ppm`、`dust_ug_m3`、`illuminance_lux`。GP2Y1010 对应粉尘浓度估算值，不使用 PM2.5 字段或标题。
- 不新增第四个共享代码项目、Docker、Redis、ORM、通用插件体系或复杂状态管理。

## MQTT 必须一致的部分

上传结构与校验依据：

- `D:\00_Graduation_Project\Docs\contracts\telemetry.schema.json`
- `D:\00_Graduation_Project\Docs\contracts\telemetry.example.json`
- `D:\00_Graduation_Project\Docs\数据接口协议草案.md`

主题统一为 `envmon/v1/devices/{device_id}/telemetry`、`ack`、`status`。telemetry 与 ack 使用 MQTT 3.1.1、QoS 1、retain false；status 可使用 retained 消息和遗嘱。

去重键为 `(device_id, boot_id, seq)`。后端提交 SQLite 事务后返回 `stored` 或 `duplicate`，节点收到匹配确认才删除待发记录。相同标识不同内容返回 `rejected` 与 `MESSAGE_CONFLICT`，不覆盖旧记录。

ACK 正文直接为 JSON 对象，不添加 HTTP 的 data 包装：

```json
{
  "schema_version": 1,
  "device_id": "classroom-001-node-001",
  "boot_id": "7c9a21f0",
  "seq": 1,
  "status": "stored",
  "stored_at": "2026-10-16T02:00:00.080Z"
}
```

明确永久拒收时返回同一消息标识、`status: rejected` 和 `error: {code, message}`，不包含 `stored_at`。临时数据库故障不返回成功，不让上传端删除数据。

## HTTP 最小接口

所有路径均以 `/api/v1` 开头，失败统一 `{ "error": { "code": "...", "message": "..." } }`。示例中的时间用于说明格式，运行时必须使用实际时间。

### 健康检查

`GET /api/v1/health`

```json
{"data":{"status":"ok","mqtt":true,"database":true}}
```

依赖未就绪返回 503，不能只检测 HTTP 端口。

### 最新数据

`GET /api/v1/devices/{device_id}/latest`

有数据时 `data` 为一个快照对象。快照先包含 telemetry 样例中的全部业务字段，再增加以下字段：

```json
{
  "id": 1,
  "received_at": "2026-10-16T02:00:00.080Z",
  "stored_at": "2026-10-16T02:00:00.080Z",
  "effective_at": "2026-10-16T02:00:00.000Z",
  "time_quality": "device",
  "device": {
    "online": true,
    "stale": false,
    "last_seen_at": "2026-10-16T02:00:00.080Z"
  },
  "alarms": []
}
```

上例仅展示新增字段，并非完整快照。`alarms` 仅包含当前活动报警，元素为 `{metric, state, triggered_at}`，其中 state 为 `high` 或 `low`。缺测不作为正常或恢复。暂无记录时返回 `{ "data": null }`；未登记设备返回 404。

未知采样时间使用 `effective_at = received_at` 和 `time_quality = received_only`，不得伪造采样时间。默认最新有效采样超过 10 秒则 stale；收到历史补传不刷新有效采样的新鲜度。

### 历史曲线

`GET /api/v1/devices/{device_id}/series?start=...&end=...&metric=co2_ppm&max_points=600`

```json
{
  "data": [
    {"time":"2026-10-16T02:00:00.000Z","value":720,"count":1}
  ],
  "meta": {
    "metric":"co2_ppm",
    "bucket_seconds":2,
    "start":"2026-10-16T02:00:00.000Z",
    "end":"2026-10-16T03:00:00.000Z"
  }
}
```

时间范围为 `[start, end)`，按时间升序，最大 1200 点，按需要扩大桶宽，桶内求均值并统计有效样本数。忽略 null，空桶可返回 `value: null, count: 0`，不得补零。完全无记录时 `data: []`。本轮只允许最近或历史中不超过 7 天的单次查询，超范围返回 400，不实现无限历史统计。未知采样时间的记录不混入声称基于采样时刻的曲线。

### 简单阈值

`GET /api/v1/devices/{device_id}/thresholds` 返回 `{data: ThresholdConfig}`。

`PUT /api/v1/devices/{device_id}/thresholds` 请求正文为 ThresholdConfig 去掉 version 后的内容，成功返回新的 `{data: ThresholdConfig}`。默认工程演示配置如下，不声明为国家标准：

```json
{
  "version": 1,
  "consecutive_samples": 3,
  "rules": {
    "temperature_c": {"enabled":true,"lower":16,"upper":30,"hysteresis":1},
    "humidity_rh": {"enabled":true,"lower":30,"upper":70,"hysteresis":3},
    "co2_ppm": {"enabled":true,"lower":null,"upper":1000,"hysteresis":100},
    "dust_ug_m3": {"enabled":true,"lower":null,"upper":100,"hysteresis":10},
    "illuminance_lux": {"enabled":true,"lower":200,"upper":null,"hysteresis":20}
  }
}
```

阈值持久保存；服务端校验上下界、非负迟滞和有效恢复区间。连续 3 条新鲜有效采样超限触发，连续 3 条回到恢复区间解除。高报警在回落至 `upper - hysteresis` 时计恢复，低报警在回升至 `lower + hysteresis` 时计恢复；直接越过另一侧告警界限不算恢复。新鲜度和明显未来时间的判定由后端统一处理，本轮拒收超过服务端时间 5 秒的采样。规则修改后清空未完成的连续计数，从后续新采样重新计算；已激活报警从后续新采样按新规则判断恢复，不伪造采样。

本轮只做当前报警与简单阈值设置，不做独立报警记录中心、报警通知、复杂规则编辑器或硬件声光控制。当前报警连续计数可保存在内存，重启后从新采样重新计算，此限制写入 README。

### SSE

`GET /api/v1/events?device_id=classroom-001-node-001`

- `measurement.created`：正文为已入库的测量记录，即全部 telemetry 字段加 id、received_at、stored_at、effective_at、time_quality；不带 HTTP data 包装。
- `device.updated`：正文为 `{device_id, online, stale, last_seen_at}`。
- `alarm.changed`：正文为 `{device_id, alarms}`，alarms 结构与最新快照一致。
- `thresholds.updated`：正文为 `{device_id, config}`，config 为上述 ThresholdConfig。

约 15 秒发一次注释心跳。前端断线后自动重连并重新查询最新快照；一页只开一条 EventSource 连接。本轮不做无限事件重放。前端可在 measurement 事件后重新获取 latest，以统一实时数值和当前报警；重连时先订阅再取快照，合并时防止历史数据覆盖新读数。

## 文件与安装协作

三个 Agent 各自只修改对应项目目录，不修改其他项目、原始 Word 或共用协议。发现接口问题先在自己项目 README 写明，不自行另造接口。

每个项目各自维护 package.json、package-lock.json、.npmrc 和 node_modules。三个 Agent 可以同时在自己的项目目录运行 npm install、编码、构建和测试，无需等待另一项目先完成。不要在 Projects 容器目录创建统一 package.json、锁文件或 npm workspaces，也不要运行 --workspace 命令。

每个项目提供自己的 `dev`、`start` 或 `build` 脚本，在该项目目录用 npm run 调用；本轮不增加全局启动器。后端未就绪时，其他 Agent 先完成各自独立验证并报告待联调项。三个项目就绪后，再由主 Agent 或用户协调三进程联调。不要为了获得运行结果擅自创建、改写或启动其他 Agent 的项目代码。
