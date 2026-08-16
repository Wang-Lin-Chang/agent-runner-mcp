# agent-runner-mcp 实验记录

> 原则：没实测不声称。本记录按原始数据核对。

## EXP-1 MCP 协议层实测（零依赖实现）

MCP server 零依赖自实现（stdio JSON-RPC + LSP Content-Length 帧/newline 帧双支持，协议版本回退协商 2024-11-05）。标准 MCP client（同规范握手）实测：initialize 握手 / tools/list 六工具 / 沙箱任务全链路（task_run → EXIT:0 → 输出捕获 → 尸检 D-01）/ 崩溃收养（kill runner → 三证据判定 crashed-before-exit → D-08）/ 失败链路（EXIT:1 → D-02）——**15 断言 / 0 失败**。

零依赖的由来（环境实验）：沙箱环境下 npm install 首次装包时 spawn powershell 失败（ENOENT，对照：已有 node_modules 的目录安装成功），且拷贝目录树出现 EIO——判决：绕开第三方依赖，MCP 协议层手写（与 schedule-core 零依赖招牌一致）。

## EXP-2 Claude Code 真实客户端握手

Claude Code 2.1.92 注册本 server（`claude mcp add agent-runner -- node dist/server.js`）→ 健康检查 **✓ Connected**——真实客户端的 initialize + tools/list 握手通过。会话内工具调用需要登录态（本机 loggedIn: false），未实测不声称。

## EXP-3 Windows runner ACL 持久性（EPERM 判决）

任务结束后，Windows runner 施加的目录级 ACL deny 仍有效——server 写任务目录内 autopsy.json 被 EPERM 拒绝（实测证据）。判决：观测方产物（尸检报告）不得写入证据区，落任务目录外的兄弟文件（`<jobDir>.autopsy.json`）。协议纪律：观测与证据分离。

## EXP-4 死亡语义矩阵（autopsy-spec 分类学对齐）

| 场景 | exit 协议 | death_code |
|---|---|---|
| 正常完成 | EXIT:0 | D-01 |
| 任务失败（exit 1）| EXIT:1 | D-02 |
| 沙箱施加失败（fail-closed）| EXIT:-998 | D-02（manner 注明 sandbox apply failed）|
| 篡改证据 | EXIT:-999 | D-06 |
| 崩溃（runner 死，exit 缺失）| 无 | D-08 |

MCP 层实测覆盖 D-01/D-02/D-08 三径；-998 在 Windows CI 管理员环境实测；-999 由 dsh-witness EXP-5 背书。
