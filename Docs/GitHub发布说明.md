# GitHub 发布说明

本文件说明已整理的公开内容与发布操作。生成本文件并不代表远程仓库已经创建或代码已经上传；实际结果以 GitHub 仓库 URL 和远程提交记录为准。

本次目标仓库已由项目所有者指定为 [akxxxi/indoor-environment-monitoring](https://github.com/akxxxi/indoor-environment-monitoring)。

## 公开内容

公开版本包含三个子项目的源代码、各自锁文件、JSON Schema、设计与验收文档、展示截图、答辩 PPT 和启动/验证脚本。仓库名称为 `indoor-environment-monitoring`，简介可使用：

> 知境：基于 MQTT、SQLite、Express、React 与 ECharts 的教室环境监测软件 MVP，支持实时看板、历史查询、迟滞报警与断线补传。AI 协作开发，当前使用虚拟采集节点。

项目是 Windows 本机软件验证系统。真实 STM32 / ESP8266 固件、传感器采集、标定、鉴权与云部署尚未实现。详细边界和 AI 协作说明见根目录 README。

以下内容继续保留在本地，默认不上传：

- 原始毕业设计 Word 附件（可能含学生标识及教师信息）。
- `Docs/求职项目经历与学习指南.md`、`Docs/答辩讲稿与问答.md` 与 `Docs/个人材料/`。
- `.env` 及本机环境配置；保留不含凭证的 `.env.example`。
- SQLite 数据库、待确认队列、依赖、npm 缓存、构建目录、运行日志和临时测试证据。

答辩 PPT 可包含项目作者姓名。公开前按本人意愿核对姓名、学校、教师信息；避免放入学号、联系电话和个人邮箱。原始 Word 和个人材料未被删除。

## 无需 Git 的源码 ZIP

在项目根目录执行：

```powershell
node scripts/export-github-package.mjs
```

该脚本只使用 Node.js 内置模块，不需要初始化仓库或安装额外依赖。输出到：

- `tmp/github/classroom-environment-monitor-source.zip`
- `tmp/github/classroom-environment-monitor-source.manifest.json`

清单记录文件路径、字节数与 SHA-256；ZIP 内也有同样的 `PUBLISH-MANIFEST.json`。该脚本使用明确的排除规则，不自动解析 `.gitignore`；新增个人材料时请同时更新脚本和 `.gitignore`。导出前请完成 PPT 与截图写入。脚本拒绝符号链接、大于 50 MiB 的单文件，并默认排除所有 Word、数据库、环境、私钥、日志和已有 ZIP。

ZIP 供备份与人工核对。使用 GitHub 网页上传时应先解压后上传文件内容，直接上传 ZIP 只会得到一个压缩包，无法在仓库中正常浏览源代码。

## 使用 Git 推送

目标地址为 `https://github.com/akxxxi/indoor-environment-monitoring.git`。不要把 GitHub 密码或 token 写进文档、源码、终端命令或聊天。当前项目根目录无需初始化为 Git 仓库；发布在 `tmp/github-publish/repo` 隔离目录中完成，只按源码 ZIP 清单复制待公开文件。

本机已有 Git Credential Manager，若尚未登录，由账号本人在 PowerShell 执行以下命令，并在打开的浏览器中完成认证：

```powershell
git credential-manager github login --username akxxxi --browser
```

登录只建立本机认证，不会自行上传项目。不要在聊天中发送验证码、密码或 token。

材料定稿后重新导出 ZIP，校验清单并复制到隔离目录，再核对暂存文件、提交并推送。推送前重新 `fetch` 目标仓库；已有远程历史时在其基础上添加，不 force push，也不删除远端已有文件。隔离目录中的最终检查命令为：

```powershell
git -C tmp/github-publish/repo remote -v
git -C tmp/github-publish/repo fetch origin
git -C tmp/github-publish/repo status --short
git -C tmp/github-publish/repo diff --cached --stat
git -C tmp/github-publish/repo diff --cached --name-only
git -C tmp/github-publish/repo diff --cached --check
```

确认提交仅含计划公开的材料，且本地分支延续远端现有历史后，再执行常规 `git push -u origin main`。推送应在隔离仓库目录中执行，或为 Git 命令加上相同的 `-C tmp/github-publish/repo` 参数。真实上传状态以远程提交和仓库网页为准。

## 复现与验证

克隆后安装 Node.js 24.15.0（版本见 `.nvmrc`），在 Windows 双击 `start.cmd`，或在 PowerShell 执行 `./start.cmd --scenario demo`。启动器自动按各项目锁文件安装缺失依赖，再启动后端、网页与虚拟节点；首次安装需要网络。

独立安装与基础检查可执行：

```powershell
npm --prefix Projects/server ci
npm --prefix Projects/simulator ci
npm --prefix Projects/web ci
npm --prefix Projects/server test
npm --prefix Projects/simulator test
npm --prefix Projects/web test
npm --prefix Projects/web run build
```

浏览器与全链路验证还需要本机 Chrome，必要时设置 `CHROME_PATH`：

```powershell
npm --prefix Projects/web run test:browser
npm --prefix Projects/web run test:preview
node scripts/verify-system.mjs
```

全链路脚本使用独立测试端口和 `tmp` 数据，不写正式数据库。历史验证结果见 [三端联调验收记录](三端联调验收记录.md)，不要把历史结果自动当作任何新环境的结果。

已提供 `.github/workflows/ci.yml`：Windows runner 上安装锁文件依赖、运行三个项目的 `npm test`，并构建 Web。工作流不包含本机 Chrome 和整体联调，首次上传后需在仓库 Actions 页面检查实际结果。Actions 已固定官方 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) 的提交 SHA（2026-10-17 核对）。

## 许可证与后续维护

当前未代替作者选择开源许可证。需要允许他人使用和再分发时，由作者确定许可范围后补充 LICENSE。发布时保留依赖及其锁文件，不把依赖包源码复制进仓库。

后续修改先运行受影响项目的测试；涉及 MQTT / ACK / Schema 时核对服务端与虚拟节点契约，涉及网页数据同步时运行浏览器检查，涉及启动/恢复时运行整体联调。新增真实硬件后应单独补充固件、接线、传感器型号与标定证据，再更新 README 中的实现范围。
