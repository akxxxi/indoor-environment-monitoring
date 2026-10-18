# 后端 Agent 提示词

你负责本毕业设计的本地后端基础 MVP。请直接在现有工作区完成代码、必要验证和运行说明，不停留在方案讨论。本轮只做最小闭环，不追求通用平台。

工作区：`D:\00_Graduation_Project`  
你的项目：`D:\00_Graduation_Project\Projects\server`

## 先读取

1. `D:\00_Graduation_Project\Docs\Agent提示词\MVP共用约定.md`
2. `D:\00_Graduation_Project\Docs\数据接口协议草案.md`
3. `D:\00_Graduation_Project\Docs\contracts\telemetry.schema.json`
4. `D:\00_Graduation_Project\Projects\server\README.md` 和 `.env.example`
5. `D:\00_Graduation_Project\Projects\server\package.json`

共用约定确定本轮返回格式与最小范围；完整计划书中后续功能不是本轮的追加任务。不要修改共用协议。如果发现矛盾，在交付说明中指出，并优先保持三项目的共用接口一致。

## 必须完成

1. 使用 JavaScript ESM、Express、Aedes 与 SQLite，在一个 Node.js 进程内启动 HTTP 3000 和 MQTT 1883，默认只监听 127.0.0.1。沿用本机 Node.js 24.15.0，优先使用 `node:sqlite`，不引入 ORM。
2. 自动创建本地数据库与默认教室、设备配置。保存五项指标、原始消息标识、采样及接收时间、数据来源；阈值也持久保存。用少量建表 SQL 即可，不建通用迁移平台。
3. 接受真实 MQTT 上传，校验 Schema、1024 字节负载上限、主题与 device_id、教室归属、时间及数值。拒绝 retained telemetry，错误输入不能拖垮服务。
4. 唯一约束为 `(device_id, boot_id, seq)`。相同内容重复上传返回 duplicate；相同标识不同内容返回 MESSAGE_CONFLICT，不覆盖已有数据。只有事务提交成功才能发送 stored 确认，数据库故障不能返回成功。
5. 实现共用约定中的 health、latest、series、thresholds GET/PUT 和 events。series 用简单 SQL 时间桶求均值，最多 1200 点，本轮单次范围最多 7 天。保留原始记录，不自动删除。
6. SSE 在入库后推送事件，支持心跳和断开清理；重复消息不重复触发测量事件。最新值按采样时间选取，旧补传不能覆盖最新值或触发当前超限报警。
7. 实现简单上下限、连续次数与迟滞判断。使用共用约定的工程演示默认阈值，网页可读取和修改；报警计数可在内存中维护，不做报警历史中心。
8. 将在线状态与数据过期分开处理，默认 10 秒无新鲜采样即 stale。正常退出关闭 HTTP、MQTT、SSE 和数据库，说明端口占用等常见启动问题。

## 保持简单

- 少量清晰模块足够，例如入口、MQTT、数据库、HTTP、报警。不写抽象基类、依赖注入框架或插件系统。
- 不做多租户、多用户、权限、云平台、Docker、Redis、OTA、远程控制或标准合规评分。
- 暂不实现完整 rooms/devices 管理、原始数据分页端点、独立报警记录端点或 SSE 永久事件日志。
- 不编写 simulator 或网页来替别人完成项目；验证可用项目内的临时 MQTT 测试客户端和 HTTP 请求。
- 选择经过官方资料核对的兼容依赖版本并锁定，不为了追新使用 beta。不要因常规实现选择反复要求用户确认。

## 修改范围

只修改 `Projects/server`，包括自己的 package.json、package-lock.json、.npmrc、node_modules、源代码与 README。三个项目依赖独立，你可以与其他 Agent 同时安装、编码和测试，无需等待。不要在 Projects 下创建统一依赖文件，不要改其他项目、原始 Word 或规划文档。不提交 Git、不部署。不要创建新 Agent 或新聊天。

## 验收与交付

- 在 `D:\00_Graduation_Project\Projects\server` 内执行 `npm install` 和 `npm run dev`；提供 start 脚本与 `.env.example`，依赖和锁文件均保存在本目录。
- 实际验证健康检查、MQTT 入库、重复投递、同标识内容冲突、重启保留历史、latest、series、阈值保存与 SSE。重点验证一次数据库失败不会产生成功 ACK；可用临时数据库与可控失败测试，不添加生产故障注入接口。
- 使用 `node:test` 覆盖必要的去重与报警状态判断，避免为每个简单函数堆测试。测试数据库不得污染正式演示数据。
- 更新项目 README，给出安装、启动、最短 MQTT/HTTP 验证步骤，以及本轮限制。附共用接口的实际响应样例。
- 最终报告修改内容、准确命令、已通过的验证、未完成内容。其他项目未就绪时不宣称全链路通过，也不要无限等待；交付你的独立验证结果和待联调项。
