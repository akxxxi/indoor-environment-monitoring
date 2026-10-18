# 虚拟节点 Agent 提示词

你负责本毕业设计的虚拟上传节点基础 MVP。请直接在现有工作区完成代码、必要验证和运行说明。目标是让没有 MCU 硬件时也能向本地后端持续上传，并简单验证断线补传。

工作区：`D:\00_Graduation_Project`  
你的项目：`D:\00_Graduation_Project\Projects\simulator`

## 先读取

1. `D:\00_Graduation_Project\Docs\Agent提示词\MVP共用约定.md`
2. `D:\00_Graduation_Project\Docs\数据接口协议草案.md`
3. `D:\00_Graduation_Project\Docs\contracts\telemetry.schema.json`
4. `D:\00_Graduation_Project\Docs\contracts\telemetry.example.json`
5. `D:\00_Graduation_Project\Projects\simulator\README.md` 和 `.env.example`

后续 STM32F103C8T6 和 ESP8266 要复用这里的网络数据契约。本轮只写 Node.js 虚拟节点，不涉及任何固件、硬件或串口程序。

## 必须完成

1. 使用 JavaScript ESM 与 MQTT 客户端，每 2000 ms 生成并上传一次五项指标，默认一个教室、一个设备，连接 `mqtt://127.0.0.1:1883`。
2. 严格沿用共用 Schema 与主题。`source` 固定为 simulator；GP2Y1010 对应 `dust_ug_m3`，不增加 PM2.5 字段。采样时间使用实际 UTC 时间，boot_id 每次进程启动独立生成，不能被固定演示随机种子固定。
3. 数值平滑变化、范围合理，支持固定随机种子复现测量趋势。只做 normal、co2_high、dust_high、demo 四种情景。demo 在正常、超限、恢复间循环，用于快速展示连续触发和恢复；允许通过环境变量切换，不写复杂 CLI 框架。
4. 使用一个本地 SQLite outbox，先保存采样再发送。MQTT QoS 1，telemetry retain false；只有收到对应 stored 或 duplicate 应用 ACK 才删除记录，PUBACK 不能作为删除依据。
5. 保持一条在途消息，ACK 超时后重试；断线时继续按 2 秒采样入队，恢复后按生成顺序补传。重连并确认 ack 主题订阅成功后再发送，避免漏掉快速返回的确认。不要每条消息等待 2 秒才补传，应能逐步排空积压。
6. 重启后保留并补传原始队列，不能重写旧消息的 boot_id、seq 或 sampled_at。默认队列最多 43,200 条，满时停止接纳新采样并输出清晰提示，不静默覆盖旧记录。
7. 对可关联的永久 rejected 消息保留拒收原因并移出待发队列，避免阻塞全部上传。对暂时无确认或断网保留待发数据，用简单退避重试。
8. 打印必要日志：连接、情景、采样序号、队列长度、发送、入库确认和重连。提供 online 状态与 offline 遗嘱；正常退出停止采样并关闭连接、数据库。

## 保持简单

- 小型数据生成器、outbox 和 MQTT 主流程足够，不实现通用设备模拟平台。
- 不写硬件驱动、串口、Web 控制面板、多节点管理、传感器插件、批量历史造数工具或性能压测框架。
- 不用直接写 server 数据库代替 MQTT 上传，不靠绕过 ACK 来伪造成功。
- MQTT 客户端加运行时自带 SQLite 优先，必要校验可少量实现；不同时引入多套校验和重试库。
- 不复制或实现真正的后端。后端未启动时，程序应能离线采样入队，且可以独立验证队列重启保留。

## 修改范围

只修改 `Projects/simulator`，包括自己的 package.json、package-lock.json、.npmrc、node_modules、源代码与 README。三个项目依赖独立，你可以与其他 Agent 同时安装、编码和测试，无需等待。不要在 Projects 下创建统一依赖文件，不要改其他项目、原始 Word 或共用协议。不提交 Git、不部署。不要创建新 Agent 或新聊天。

## 验收与交付

- 在 `D:\00_Graduation_Project\Projects\simulator` 内执行 `npm install` 和 `npm run dev`；提供 start 脚本与 `.env.example`，依赖和锁文件均保存在本目录。
- 至少验证连续生成并上传 10 条消息、待发队列在进程重启后保留、断线后补传排空、重复 ACK 幂等处理。若后端已就绪，验证数据库唯一行数与生成的唯一消息数一致。
- 用少量 `node:test` 或可执行验证脚本覆盖队列保留和匹配 ACK 后删除这两项关键行为，不写大量镜像测试。
- README 给出正常、demo、超限情景的准确启动方式，以及如何通过停止和重启后端验证缓存补传。
- 后端未就绪时，不擅自修改后端或无限等待；完成本项目的独立验证，明确哪些 MQTT 联调尚未执行。
- 最终报告改动、启动命令、验证结果、演示步骤和剩余限制。
