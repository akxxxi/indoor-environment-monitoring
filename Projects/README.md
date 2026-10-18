# 软件项目工作区

三个独立 npm 项目均已实现，各自维护依赖、锁文件和安装目录，不使用 npm workspaces。

| 项目 | 包名 | 职责 |
| --- | --- | --- |
| simulator | @envmon/simulator | 生成五项指标，MQTT 上传、应用 ACK 和持久队列补传 |
| server | @envmon/server | 内嵌 MQTT、校验、SQLite、REST、SSE 和报警 |
| web | @envmon/web | Vite React 中文仪表盘、历史趋势、阈值设置 |

完整系统在项目根目录双击 start.cmd 启动。使用方式和参数见 [根目录 README](../README.md)，实际联调见 [验收记录](../Docs/三端联调验收记录.md)。

分别开发时进入对应目录执行 npm ci、npm run dev；请先停止整体启动器，避免端口占用。协议与 JSON Schema 在 Docs 中供三端及后续 MCU 共用，不新增统一依赖项目。

