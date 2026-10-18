# 知境 · 教室环境监测 Web MVP

Vite + React（JavaScript JSX）+ ECharts 的中文单页应用，仅包含**实时看板、历史查询**两个页签和工程演示阈值弹窗。默认教室 `classroom-001`、设备 `classroom-001-node-001`，无账号和设备管理功能。

## 安装与启动

在 PowerShell 中运行：

```powershell
Set-Location 'D:\00_Graduation_Project\Projects\web'
npm install
npm run dev
```

浏览器访问 <http://127.0.0.1:5173>。使用 Node.js `>=24.15.0 <25`、npm `>=11 <12`；依赖、锁文件、`node_modules` 和 npm 缓存都在本项目内。`.npmrc` 使用 npm 官方源，避免继承不可用的镜像源。

开发服务器固定使用 5173，端口被占用时明确报错。默认仅绑定 `127.0.0.1`。如需用同一局域网手机访问，可自行运行 `npm run dev -- --host 0.0.0.0`，并使用本机局域网 IP 的 5173 端口；当前验证使用浏览器 390 px 视口，未做实体手机联调。

构建和本地预览：

```powershell
npm run build
npm run preview
```

构建产物在 `dist/`，预览地址 <http://127.0.0.1:4173>。任务结束时会停止本轮启动的预览/开发进程，请按需重新启动。

## 后端与代理

正常运行依赖独立的 `Projects/server` HTTP/SSE 服务，以及产生真实运行数据的虚拟节点。Web 只连接 HTTP，不直接连接 MQTT，也不会启动其他项目。

无需创建 `.env` 即可使用默认值。需要修改时复制 `.env.example` 为本目录的 `.env.local`，修改后重启 Vite：

```dotenv
VITE_API_BASE_URL=/api/v1
DEV_API_TARGET=http://127.0.0.1:3000
```

- 浏览器 REST 和 SSE 共用 `/api/v1`，开发服务器与 `vite preview` 把 `/api` 原样代理至 `http://127.0.0.1:3000`，不移除路径前缀。SSE 不设置普通请求的代理超时。
- `DEV_API_TARGET` 仅由 Vite 读取，不进入浏览器代码。保留同源 API 地址即可避免本地跨域配置。
- 部署静态 `dist/` 时需由实际 Web 服务配置同源 `/api` 反向代理，Vite 的开发代理不会随静态文件部署。本轮不发布网站。
- 前端按 `Docs/Agent提示词/MVP共用约定.md` 消费 `latest`、`series`、`thresholds` 和 `events`；不请求全部原始历史记录，不扩展另一套 API。
- 后端未启动时显示连接失败、快照/曲线错误与读数占位。**正常页面没有 fixture 开关、随机数或 mock 服务。**

## 实时看板

- 五张指标卡分别展示温度、相对湿度、CO₂ 浓度、**粉尘浓度估算值（μg/m³）**和光照强度。缺测保留 `—` 和文字说明，合法的零值正常展示。
- 设备在线状态、SSE 连接状态、最新采样时间、最近接收时间、时间质量和数据新鲜度分别显示。`source: simulator` 明确标记“虚拟数据 · 模拟节点”。
- 默认选择 CO₂。点击卡片或曲线指标按钮切换单项指标；每张曲线只使用一种单位。
- REST 获取初始快照和最近 10 分钟聚合曲线，单条 EventSource 订阅四种命名事件。每次连接成功（包括重连）重新获取最新快照、曲线和阈值。
- 测量按记录 ID 去重；最新值按 `effective_at` 和记录 ID 比较，较旧补传与晚到 REST 响应不能让卡片回退。REST 请求期间到达的报警/设备事件有修订标记保护，不被旧响应覆盖。
- 实时缓存限制为最近 10 分钟且最多 1200 条，去重集合最多 2400 个 ID。曲线 REST 每次最多请求 600 点。采样时间落在已查询区间的补传会合并触发重新查询，由后端重新聚合，避免叠加桶均值与原始值。
- 无新数据时，每秒钟检查采样年龄；有效采样超过 10 秒或后端标记 stale 时保留读数并标为过期。`received_only` 显式显示“采样时间未知”，不声称数据新鲜、不加入基于采样时间的实时曲线。
- 正式报警只展示后端 `alarms` / `alarm.changed`，不根据前端阈值自行推断。后端确认报警移除后出现恢复反馈；缺测本身不触发恢复。

## 历史查询

1. 选择最近 1 小时、6 小时、24 小时或自定义开始/结束时间。
2. 选择指标，点击“查询趋势”。自定义时间使用浏览器本地时区，发送前转换为 UTC。
3. 单次时间范围不得超过 7 天，必须满足开始早于结束。后端仍做最终校验，查询区间为 `[start, end)`。

仅调用 `series`，请求 `max_points=600`；显示后端聚合桶宽，缺测断开曲线、不补零。加载、空结果、无有效指标值、请求错误均有对应状态。修改条件会取消旧请求并清除旧曲线，避免把旧指标或旧时间范围结果放在新筛选条件下。

## 阈值设置

点击右上角“阈值设置”读取后端配置，编辑各指标启用状态、下限与上限。空白边界提交为 `null`；连续样本数与迟滞缓冲沿用服务端配置，不提供复杂规则编辑器。

PUT 提交完整配置但移除 `version`，成功后展示服务端返回版本。错误时保留输入并显示服务端原因。版本较旧的 GET 或事件不会覆盖较新的配置；弹窗打开后不会静默覆盖正在编辑的输入。

阈值属于工程演示配置，不声明为国家标准。规则更新后的超限和恢复需后续新鲜有效采样确认。根据共用约定，后端活动报警的连续计数可能只保存在内存中，服务重启后从新采样重新计算；前端没有独立的持久报警记录。

## 界面与生命周期

暖灰背景、白卡片和青绿色重点色；桌面并排卡片与状态栏，窄屏自动分列。数字过渡、图表更新、页签和弹窗使用适度动画，遵循系统 `prefers-reduced-motion` 设置。使用本机字体，无远程图片/字体依赖。

React StrictMode 下 effect 清理会关闭 EventSource、取消 HTTP 请求、清理间隔/补传定时器与数字动画，并释放 ResizeObserver、媒体查询监听和 ECharts 实例。切换历史页不再保留实时图表实例，整页仍只维持一条实时连接。弹窗支持焦点限制、Escape 关闭和焦点恢复，页签支持键盘方向键。

## 验证

```powershell
npm test
npm run test:browser
npm run build
npm run test:preview
```

`npm test` 为 4 项数据完整性检查：补传/旧快照不回退、随时间过期、ID 去重/窗口/缺测及 7 天查询边界。`test:preview` 在构建后检查生产产物能否挂载 React 和初始化 ECharts，防止开发模式无法暴露的分包循环依赖问题。没有针对静态 JSX 或样式堆单元测试。

Playwright 默认使用本机已安装的 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`。其他安装位置可在当前 PowerShell 会话设置 `$env:CHROME_PATH` 后执行；不额外下载浏览器。测试可复用已运行的开发服务器，也可自行启动并在结束后关闭它。

浏览器测试通过**仅在测试浏览器内**拦截 REST、替换 EventSource 来控制确定性场景；fixture 页面顶部明确显示“自动化验证 fixture · 非真实后端”。没有新增 mock 服务，正常 Vite 页面不会注入数据。截图保存在 `test-results/`，Playwright 的失败附件分别位于其中的 `browser/` 和 `production/`，对应附件目录会在每轮测试时重置。

2026-10-16 本轮实际结果：

- `npm install` 成功，依赖与锁文件落在 Web 项目。
- `npm run dev` 成功启动，实际浏览器访问返回 HTTP 200。
- `npm run build` 和 4/4 项数据完整性检查通过。
- 10/10 项 Chrome 开发页面检查通过：连接失败/占位、桌面实时值/缺测、重复 ID/补传、重连重新请求、单条连接/单个时钟定时器、自动过期、后端报警恢复、历史范围/空结果、阈值失败与成功保存、请求竞态、未知采样时间、390 px 和减少动态效果，以及阈值服务失败后重试保存并清除同步错误。
- `npm run preview` 实际启动，生产页面 HTTP 200、React/ECharts 正常渲染、无未捕获运行异常；1/1 项生产预览回归检查通过。构建分包已修复，当前构建无分包大小警告。
- 已查看桌面、390 px 手机及阈值弹窗截图；测试场景无未捕获页面异常。网络失败的浏览器资源错误是预期状态。
- 另用**不拦截网络、不注入 fixture**的真实开发页面检查：HTTP 200，页面显示“连接失败 · 自动重试”、代理 HTTP 502、指标占位，浏览器无未捕获异常；当时 `GET http://127.0.0.1:3000/api/v1/health` 为 `ECONNREFUSED`。

**后续整体联调已完成**：真实节点上传、SQLite 历史聚合、阈值持久化、报警触发/恢复及 SSE 断线重连均通过，见 [三端联调验收记录](../../Docs/三端联调验收记录.md)。联调修复了代理 500/502 导致 EventSource 永久 CLOSED 后不再重连的问题，新增专门回归检查；当前浏览器测试为 11/11。整体系统在根目录双击 `start.cmd` 启动，独立复验使用根目录 `node scripts/verify-system.mjs`。

实现时参考 [Vite 代理配置](https://vite.dev/config/server-options#server-proxy)、[React effect 清理](https://react.dev/reference/react/useEffect) 与 [ECharts 实例尺寸和释放](https://echarts.apache.org/handbook/en/concepts/chart-size/)。
