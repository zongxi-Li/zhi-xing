# PR-HANDS-00 ｜ 知弈独立执行引擎（ZhiYi Hands）预研报告

**日期**: 2026-10-27 ～ 2026-10-28 ｜ **性质**: 预研（未进入知弈正式执行链路，未修改任何知弈 Runtime 代码）
**工作区**: `C:\Users\LZX\Desktop\zhiyi Hands\`（隔离，无 git，不提交不推送）
**知弈权威源**: 本地 `C:\Users\LZX\Desktop\kinlin_ai`（master @ ee16607f，双镜像 GitHub/Gitee，只读访问）
**DSH 参考源**: `deepseek-ai/deepseek-harness @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（克隆快照）

标记约定：**VERIFIED** = 有源码/运行证据；**PROPOSED** = 本报告设计，未实现；**BLOCKED** = 受阻，证据在案。

---

## 一、结论摘要

1. **提取可行且已验证**：DSH 的执行基座（fs / subprocess / win32-process / sandbox / shell 五组共 16 个子包）与 Agent Loop、Session、LLM 在源码级解耦。以"**保留最小 Cordis 运行容器 + tsconfig paths 源码直用**"方案，Hands-P0 已在本机（Windows 11, Node 24.19）跑通全部六项验收，**16/16 测试通过**（`hands-p0/tests/p0.spec.ts`），全程无 LLM、无第二 Planner/ACG/WorkflowRuntime、未触碰知弈主线。
2. **三种提取方案比较结论**：保留最小 Cordis（已采用，成本最低、保真度最高）> 直接提取（需重写 `Service`/`inject`/`ctx.effect` 语义，约 150+ 行容器替代品，风险在中）> 自行适配（仅作 fallback，本次未触发）。Cordis 本身是 DSH vendored 的 MIT IoC 容器（`vendor/cordis/`，Koishi 衍生），不携带任何 Agent 基础设施。
3. **知弈侧合同已对齐**：知弈已有版本化执行信封 `LocalRuntimeExecutionRequest/Result/Event`（`apps/agentOS/src/contracts/local_runtime.py:51/90/112`），Hands 协议 v"1" 逐字段镜像该家族；`docs/开发记录/PR-EX-00-执行后端架构审计与设计.md` 正是 Hands 的同构先导设计（其 §8 明确把 "DSH" 列为未来执行后端，`contracts/resource.py:62-71` RuntimeKind.EXECUTION_BACKEND 同）。
4. **一项重要安全发现（VERIFIED）**：Microsoft Store 版 pwsh（MSIX 别名）的孙进程会**逃逸** Windows Job 整树终止；原生 PowerShell 5.1 无此问题。已留存复现证据与缓解方案（`hands-p0/evidence/tree-kill-store-pwsh-escape.md`）。

---

## 二、DSH 真实模块与依赖分析（任务 A）

> 逐包追踪自真实源码（非 README）。行号引用基于快照 22ddee37。`⟨P⟩` = `deepseek-harness/packages`。

### 2.1 分层架构（VERIFIED）

DSH 是三层能力体系，全部构建在 vendored Cordis IoC 容器上：

- **Tier 1 接缝（seam）**：抽象 `Service` 类 + 词汇类型。`ctx.fs`（`⟨P⟩/fs/fs/src/index.ts:87`）、`ctx.subprocess`（`⟨P⟩/subprocess/subprocess/src/index.ts:117`）、`ctx.shell`（`⟨P⟩/shell/shell/src/index.ts:64`）、`ctx.jobs`（`⟨P⟩/jobs/jobs/src/index.ts:88`）、`ctx.sandbox`（`⟨P⟩/sandbox/sandbox/src/index.ts:174`）。
- **Tier 2 本地实现（provider/local）**：`fs-local`、`fs-sandbox`、`subprocess-local`、`win32-process`、`pwsh-local`、`bash-local`、`sandbox-local`、`sandbox-windows-acl`。
- **Tier 3 模型面工具（tool-*）**：`defineTool` 包装，**这一层才是 Agent/Session 耦合层**——Hands 不需要它。

**关键解耦证据（VERIFIED）**：
- `core/tools` 从不 import `dsh-agent-loop`（依赖方向相反：`agent-loop/src/agent.ts:34-35` import dsh-tools）；对 `dsh-agent`/`dsh-session` 的引用全部是 **type-only**（`core/tools/src/contracts.ts:4,6`），运行时缺失时 approval 优雅降级为 deny（`core/tools/src/pipeline.ts:436-441`）。
- `subprocess-local` 全 src **零** session/agent/LLM import（`ctx.logger`/`ctx.effect` 是仅有的 cordis 依赖，`subprocess-local/src/index.ts:92-99`）。
- `sandbox/sandbox` 对 session 的引用是一行 type-only `SessionId`（`sandbox/src/index.ts:10`），运行时可擦除。
- `pwsh-local`/`bash-local` 的测试即独立组装教程：`new Context()` → `ctx.plugin(LocalSubprocessRuntime)` → `ctx.plugin(PwshLocalExecutor, {graceMs})` → `ctx.shell.resolve(request)` → `execute` → `result()`（`shell/pwsh-local/tests/executor.spec.ts:54-93`）。

### 2.2 逐包要点与提取判定

| 包 | 真实入口 | 依赖闭包要点 | 判定 |
|---|---|---|---|
| fs/fs | `FileSystem extends Service`（index.ts:87），写意图 `FsWriteIntent`（types.ts:123）、错误码族 `FsErrorCode`（types.ts:175-189） | 仅 `HarnessError`（值）+ `dsh-brand`/`dsh-sandbox`（type-only） | **EXTRACTABLE_DIRECTLY**（HarnessError 为 25 行零依赖类，llm/llm/src/error.ts:13） |
| fs/fs-local | `LocalFileSystem`（index.ts:69）；原子写 `writeFileAtomic`、per-targetKey FIFO 锁（index.ts:119-132） | chokidar、koffi（仅 Windows 换 `ReplaceFileW` 保 DACL，win32.ts:46-58，懒加载） | **EXTRACTABLE_DIRECTLY** |
| fs/fs-sandbox | `SandboxedFileSystem`（index.ts:55）只覆写 `writeText/editText`，写前**重规范化 + 容含检查**（checkedTarget :122-144，抗 TOCTOU）；`containment.ts:58-76` 用 dev+ino 祖先链抗 8.3 短名/大小写别名 | 需一个 `sandboxPolicy` 服务（~20 行 stand-in） | **EXTRACTABLE_WITH_ADAPTER**（已实现） |
| subprocess/subprocess | `SubprocessRuntime`（index.ts:117）、`SubprocessSpawnSpec`（types.ts:77-107：argv 免 shell 解释、graceMs、AbortSignal）、`SubprocessHandle.collected`（:179 偏移读取器） | `dsh-http-proxy`（单函数，可 stub）、cordis | **EXTRACTABLE_DIRECTLY** |
| subprocess/subprocess-local | **Windows 双路径**：首选私有 Node runner 子进程 + Job Object（`windows-job.ts:125-247`，stdio 布局 `runner-launch.ts:119-147`，10ms 轮询 `spawn-runner.ts:323-376`）；fallback = `child_process.spawn` + `taskkill /T /F`（`spawn.ts:115-124`，DSH 自注 best-effort :117-119）。升级阶梯 `terminateWithReason`（spawn.ts:357-368） | `dsh-win32-process`、`dsh-lazy-require`、`dsh-timeout`（一常量）、koffi、node-pty（**仅终端，且 type-only + 懒加载**） | **EXTRACTABLE_DIRECTLY** |
| subprocess/win32-process | koffi FFI over kernel32：`createKillOnCloseJob`（process.ts:340-359）、`spawnJobProcess` 挂起→Assign→Resume（:415-520）、`TerminateJobObject`（:629-631）、`isJobEmpty`（:609-621）。**package.json 声明了 cordis peer 但 src 零引用（上游过声明，已核实）** | koffi | **EXTRACTABLE_DIRECTLY**（全仓最干净组件） |
| sandbox/sandbox | `SandboxMode`/`SandboxExecutionPolicy` 词汇（index.ts:30-80，**策略随调用携带而非固定在 Provider**）；`writableRoots = workspace + extra + /tmp + os.tmpdir()`（roots.ts:97-100，**临时目录恒可写是设计**） | type-only SessionId 可擦 | **EXTRACTABLE_DIRECTLY** |
| sandbox/sandbox-local + windows-acl | Windows ACL 后端 = `WRITE_RESTRICTED` 限制令牌 + 低完整性 + 能力 SID（token.ts:216-243、acl.ts:377-431），自报 `enforcement: 'partial'`，拒绝 additionalWritableRoots（sandbox-local index.ts:370-371） | 需剥离 skills 注册（sandbox-local index.ts:301-303）与 landlock-run 无条件 import（:29-34） | **EXTRACTABLE_WITH_ADAPTER**（P1，本轮未挂载未运行——`grantWrite` 会改工作区 ACL，属系统状态变更） |
| shell/pwsh-local | **每命令新进程，非持久 runspace**（argv: `pwsh -NoLogo -NoProfile -NonInteractive -Command`，index.ts:193-195）；UTF-8 编码头解决 PS5.1 OEM 码页（:48-49）；可执行解析链含 **PS5.1 兜底**（resolve.ts:67-79）；超时/中止一元化 first-cause 分类（:257-271） | 同 bash-local | **EXTRACTABLE_WITH_ADAPTER** |
| shell/bash-local | `executeArgv` 全引擎（index.ts:201-389）；输出=内存尾 + spill 全量（64KB/64MB 默认）；`[stderr]` 合并读（:342-363） | dsh-shell/subprocess/timeout | **EXTRACTABLE_WITH_ADAPTER** |
| shell/shell | 合同：`result()` 仅基础设施失败才 reject；非零退出/超时/中止均 resolve；`done` 永不 reject（index.ts:49-62） | 三组类型词汇 | **EXTRACTABLE_WITH_ADAPTER** |
| core/tools + tool-executor-native | 注册表/流水线八步（pre-execute→approval 降级→guards→around→dispatch→post-execute→finalize，pipeline.ts:62）；**无 agent-loop 依赖** | 需 stub `ctx.systemPrompt` 两个钩点（index.ts:113,332） | **EXTRACTABLE_WITH_ADAPTER**（P1 可选：Hands 若要 DSH 工具注册表） |
| tool-fs / tool-bash / tool-pwsh / tool-jobs / jobs-local | `exec.agent.session`、jobs owner 解析 `ctx.get('agents')`（jobs-local index.ts:361-372）、审批闭环、inbox 投递 | — | **INFRASTRUCTURE_COUPLED**（Hands 不取；可移植纯件：tool-bash 的 render.ts/background.ts，jobs 的 ring.ts/pump.ts） |

**README 与代码的偏差（VERIFIED，审计核出）**：(1) pwsh-local 实际可回退到 powershell.exe 5.1（README 只说 pwsh）；(2) win32-process 过声明 cordis peer；(3) jobs 接缝 README 把 tool-jobs 的完成通知语义算在自己头上；(4) fs-local 注释明言 `cwd` **不是**安全边界（fs-local/src/index.ts:63-68），围栏只在 fs-sandbox。

---

## 三、代码复用与许可证矩阵

| 组件 | 来源 | 许可证 | 复用方式 | 声明义务 | 升级成本 |
|---|---|---|---|---|---|
| fs/fs, fs-local, fs-sandbox | DSH @22ddee37 | **MIT** | 逐字 vendor（`hands-p0/vendor/packages/fs/*`，仅恢复 src/ 层级） | 保留版权与许可声明（`vendor/LICENSE`） | 低：上游 rebase 后 diff vendor 子集；面窄（三包 API 稳定） |
| subprocess, subprocess-local, win32-process | 同上 | MIT | 逐字 vendor | 同上 | 中：runner IPC 协议（runner-protocol.ts）若变需同步 |
| sandbox（词汇+roots） | 同上 | MIT | 逐字 vendor | 同上 | 低 |
| shell/shell, pwsh-local, bash-local | 同上 | MIT | 逐字 vendor | 同上 | 低 |
| cordis, cosmokit, schemastery | DSH vendor/ | MIT | 逐字 vendor（IoC 容器即"最小运行容器"） | 同上 | 低：cordis 4.x 自包含 |
| llm → `HarnessError` | DSH llm/llm/src/error.ts | MIT | 25 行类逐字拷贝 + 裁剪 manifest（`vendor/packages/llm/llm-src/`，PROVENANCE 注明） | 同上 | 近零 |
| session/sandbox-policy 类型 | DSH | MIT | 5-20 行类型 stub（`vendor/packages/stubs/`） | 注明即可 | 近零 |
| koffi 3.1.1 | npm | MIT | 依赖（版本钉死，与 DSH 同版，规避其 3.3.2 源编译问题——DSH pnpm-workspace.yaml 注释） | THIRD_PARTY_NOTICES 条目 | 低 |
| chokidar 5.0.0 / undici 8.11.2 | npm | MIT | 依赖 | THIRD_PARTY_NOTICES 条目 | 低 |
| node-pty 1.2.0-beta.15 | npm | MIT | **仅类型**；构建脚本被 pnpm 策略拒绝，运行时零加载 | 条目；未来启用终端时需 DSH 同款 patch | 高（若启用） |
| Hands 自研（protocol/grants/providers/world/engine/fallback） | 本项目 | 知弈项目许可（木兰PSL2 体系） | — | — | — |

**许可证结论（VERIFIED）**：提取闭包 100% MIT，无 copyleft、无专利陷阱、无网络服务条款约束。知弈主线（木兰PSL2）引入 MIT 组件无障碍；分发时需随附 MIT 文本与版权行，并在第三方组件清单登记 koffi/chokidar/undici/node-pty。DSH 自身 `THIRD_PARTY_NOTICES.md` 可作登记底稿。

---

## 四、ZhiYi Hands 目标架构与接口草案（任务 B+C）

### 4.1 目标架构（PROPOSED，P0 已验证其可落地）

```
知弈内核（Python, 权威）                    Hands（独立进程/组件）
┌─────────────────────────┐   IPC v1    ┌──────────────────────────────────┐
│ ExecutionRuntime（唯一真源）│ ──────────▶ │ 协议层 protocol.ts（信封校验/拒inline权）│
│ Permit/Checkpoint/Attempt │            │ 授权层 grants.ts（Grant 校验，错误码族） │
│ AuditedToolRuntime（策略） │ ◀────────── │ 引擎 engine.ts（分发/收据封章）        │
│ Provenance/Trace          │   收据/事件  │ ─── Execution World 边界 ──────────── │
└─────────────────────────┘             │ FS Provider ｜ Process Provider      │
                                        ｜ Resource Provider ｜ (P1)Sandbox Provider │
                                        │ [DSH World]  [Remote World] [QEMU World] │
                                        └──────────────────────────────────┘
```

- **不做第二权威**：Hands 无状态持久化、无图状态、无重试编排；收据+幂等键交给内核对账（知弈已有 `commitId` 节点幂等与 Provenance `operation_id` 重放语义）。
- **Execution World 边界（VERIFIED 已实现）**：`hands/providers.ts` 四接口（Filesystem/Process/Resource/Sandbox）；引擎与协议层只见接口，`hands/world.ts` 是**唯一**接触 cordis/DSH 类型的文件。已用三个互换证明：SandboxedFileSystem↔LocalFileSystem、pwsh↔bash、DSH shell↔自研 native fallback（零 DSH）。

### 4.2 版本化 IPC 协议 v"1"（PROPOSED；字段已在 TS 落地并测试）

**请求** `HandsExecutionRequest`（镜像 `LocalRuntimeExecutionRequest`，local_runtime.py:51）：
`protocolVersion:"1"`、`requestId/invocationId`、`capabilityId ∈ {fs.read,fs.list,fs.write,fs.patch,shell.exec}`、`authorization:{grantId,workspaceId}`（**系统签发引用，绝不允许内联范围**——引擎边界强制 `rejectInlineAuthority`，对齐知弈 `reject_inline_authority` local_runtime.py:62-79）、`input`、`limits:{timeoutSeconds,maxStdoutBytes,maxStderrBytes}`（local_runtime.py:38-41）、`idempotencyKey`、`identity:{runId,stepId,attemptId,commitId}`（知弈侧关联链，回显不解释）。

**收据** `HandsExecutionReceipt`（镜像 `LocalRuntimeExecutionResult`，local_runtime.py:90-109）：`status ∈ {completed,failed,cancelled}`、`startedAt≤completedAt`、sanitized `error{code,retryable,message}`、`output`、**`checksum`=sha256(canonicalJson(全字段))**（对齐知弈 `provenance_checksum`，provenance.py:18-25）。测试验证收据可离线重算校验。

**取消**：caller AbortSignal → 整树终止 → `cancelled` 收据（shell 通道）；HTTP 化时对齐 `LocalRuntimeExecutionCancelRequest`（local_runtime.py:133）。**超时**：ResourceProvider 把协议限额定为执行 deadline，first-cause 分类 `timedOut` xor `aborted`（DSH 语义）。

**授权语义**（镜像知弈 grants/service.py:23-55，VERIFIED 已实现六码）：`GRANT_NOT_FOUND / WORKSPACE_MISMATCH / GRANT_ROOT_MISMATCH / GRANT_REVOKED / GRANT_EXPIRED / CAPABILITY_DENIED`。P0 内 Hands 自签发 Grant；集成期由内核签发、Hands 只验证。

**错误码透传**：FS_* 族（fs/fs/src/types.ts:175-189）原样入收据 `error.code`；`FS_STALE_VERSION/FS_NOT_OBSERVED` 标记 retryable=true。

**传输层（PROPOSED，P1）**：与知弈 Local Runtime 同款——`POST /v1/executions` + HMAC `X-Resource-*` 头 + `Idempotency-Key` + nonce 重放拒绝（`apps/local-runtime/runtime/http_server.py:49-114`）。PR-EX-00 §4 推荐的 ACP(JSON-RPC/stdio) 适用于带会话的后端，Hands v1 无会话，签名 HTTP 足矣。本轮未实现 HTTP 面（约束"只设计接口"）。

### 4.3 Windows 执行机制与 Provider 路线（VERIFIED + PROPOSED）

- **P0（已验证）**：Job Object kill-on-close 整树终止（`CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject` → `ResumeThread`，win32-process/src/process.ts:415-520）；runner 崩溃/被杀时 kill-on-close 兜底；`waitForExit` 以 **Job 空为止**（windows-job.ts:160-177），故收据返回即孙进程已亡——本机实测验证（原生 5.1 下）。
- **安全假设边界（诚实声明）**：fs 写围栏是**可信代码内的策略检查，不是内核边界**（fs-sandbox/src/index.ts:10-18 自注）；本机实测 `writableRoots` 恒含 OS 临时目录（roots.ts:97-100），逃逸探针必须避开临时目录。本轮**不对任何隔离机制做安全保证**。
- **发现并记录的机制冲突（VERIFIED）**：Store 版 pwsh 孙进程逃逸 Job（详见 `hands-p0/evidence/tree-kill-store-pwsh-escape.md`）——列入"需要重新验证的安全假设"；缓解：装配层强制原生可执行（`shellExecutablePath` 已预留）。
- **Provider 路线**：P1 = DSH sandbox-windows-acl（限制令牌+能力 SID，`enforcement:'partial'` 自报）作为 SandboxProvider；P2 = 远程 World（同一接口，argv 换 remote launcher，与 DSH bwrap runner 同构）；远期 = Linux/QEMU 教学内核 Provider（接口无需改动，`confine()`/spawn 语义已抽象）。本轮均未实现未运行。

---

## 五、Hands-P0 样机与测试证据

**位置**: `hands-p0/`（运行方式见其 README.md）

| P0 目标 | 结果 | 证据 |
|---|---|---|
| 1. 无 LLM 文件读写 | **VERIFIED** | tests/p0.spec.ts `P0-1/4/5` describe；`evidence/demo-run.log` 前 3 行 |
| 2. PowerShell 完整采集（stdout/stderr/exitCode，UTF-8 码页处理） | **VERIFIED** | `captures stdout, stderr and the exit code`；demo step_4（exit 3, stdout/stderr 分离） |
| 3. 超时、取消、进程树 | **VERIFIED**（原生 shell 下） | timeout=1s 杀 60s sleep 且 timedOut 分类；abort→cancelled 收据；Job 整树终止（tasklist 复核孙进程已亡）；后台 handle kill |
| 4. 拒绝工作区外写入 | **VERIFIED** | FS_SANDBOX_DENIED 收据 + 文件未产生；read-only 模式全拒；fenced↔unfenced 互换对照 |
| 5. 执行身份与结果收据 | **VERIFIED** | identity 回显、checksum 重算一致、六种授权错误码逐一断言 |
| 6. Provider 可换 | **VERIFIED** | 三组互换（fs 后端/shell 种类/DSH↔自研 fallback）同协议同收据 |

- 测试：**16/16 通过**（`evidence/p0-test-run.log`，真实进程、forks 池、Windows 实机）；typecheck 干净（`evidence/typecheck.log`，含 vendor 全量、严格度与 DSH 上游等价——cordis 上游本就关闭 8 项严格标志，DSH vendor/cordis/tsconfig.json）。
- 失败证据（已转为资产）：(1) 目录深度错位致 runner 崩溃 → 修复为恢复 src/ 层级（保 `import.meta.url` 相对路径语义）；(2) Store pwsh 逃逸 Job → `evidence/tree-kill-store-pwsh-escape.md`；(3) `writableRoots` 含临时目录 → 测试设计修正。诊断脚本全部保留于 `evidence/diag-*.mts`。
- **诚实边界**：P0 是样机不是产品——无 HTTP 面、无多租户、无 Windows ACL 实跑、未做任何渗透式验证、不自评生产可用。

---

## 六、与当前 S03 开发的集成依赖清单

**本轮零接触声明（VERIFIED）**：未修改 `kinlin_ai` 任何文件；未运行知弈任何服务；无分支/提交/推送。以下全部为**未来**集成项，供 S03 之外独立排期。

| # | 依赖项 | 知弈侧位置 | Hands 侧对应 | 状态 |
|---|---|---|---|---|
| 1 | 执行信封版本对齐 | `contracts/local_runtime.py`（protocol_version Literal["1"]） | `hands/protocol.ts` HANDS_PROTOCOL_VERSION | PROPOSED（字段已对齐） |
| 2 | Grant 签发方迁移 | `apps/local-runtime/grants/`（service.py:23-55） | `hands/grants.ts`（P0 自签发） | PROPOSED |
| 3 | 收据→Provenance 映射 | `components/communicator/provenance.py`（DataProductionEvent, checksum 语义） | 收据 checksum/fieldNames 输出 | PROPOSED |
| 4 | 收据→NodeExecutionRecord/Trace 投影 | `contracts/execution.py:37-61`、`TraceEventType`（workflow.py:108-144） | receipt.identity/output | PROPOSED |
| 5 | 传输面（HMAC HTTP 或 ACP） | `apps/local-runtime/runtime/http_server.py`、PR-EX-00 §4/§11 | 未实现（P1） | PROPOSED |
| 6 | PR-EX-00 执行后端会话层 | `docs/开发记录/PR-EX-00-*.md` §6/§7（尚未有代码） | Hands 是其一个可行后端实例 | PROPOSED |
| 7 | 取消对账语义 | LocalRuntimeExecutionCancelRequest + Run 生命周期 | AbortSignal→cancelled 收据 | PROPOSED |
| 8 | 第三方声明登记 | 知弈发行物 THIRD_PARTY_NOTICES | 本报告 §3 矩阵 | PROPOSED |

**明确不做**：不接 Checkpoint/Permit/Attempt 的写路径；不注册第二工具执行器；不影响 `ExecutionRuntime` 唯一真源。Hands 收据对账完全在知弈既有幂等（commitId）与 Provenance 校验和框架内完成。

---

## 七、下一阶段具体实施建议

**P1（建议 1-2 周量级，全部 PROPOSED）**
1. **传输面**：给 Hands 加 HTTP 服务（复用知弈 local-runtime 的 HMAC/nonce 方案），使知弈内核可把 `capabilityId` 分流到 Hands——先做 shadow 模式（双跑对账，不接生产流量）。
2. **ACL SandboxProvider 挂载**：vendor `sandbox/sandbox-local` + `sandbox-windows-acl`（剥离 skills 注册与 landlock import 两处，位置见 §2.2），在**专用测试工作区**验证 `grantWrite` 授予/回收；验收"受限令牌下工作区外写入失败"。
3. **shell 可执行策略**：装配层默认探测并拒绝 MSIX 别名（`WindowsApps` 路径），优先原生 5.1/Program Files pwsh；把实际可执行路径写入收据。
4. **稳定性**：为 runner IPC 断连、Job 创建失败、spill 目录不可写补故障注入测试；`jobs/ring.ts+pump.ts` 移植以支持长输出后台任务的分段读取（P0 的 start()/kill() 已够取消语义）。

**P2**：远程 World Provider（同接口换 launcher）；`core/tools` 注册表选装（stub systemPrompt 两钩点即可独立运行）；性能与并发预算（多 Job 并行、输出上限联动 ResourceProvider 配额）。

**风险登记**：DSH 快速演进（0.2.1-rc.3）→ vendor 面窄 + 定期 rebase 策略；node-pty 1.2.0-beta（若启用终端需带 DSH patch）；Store pwsh 逃逸（P1-3 缓解后关闭）；Windows ACL 的 standing ACE 不回收属 DSH 设计（机器内残留，sandbox-local index.ts:303-310），知弈采用前需产品侧确认。

---

## 八、交付物索引

| 交付物 | 位置 |
|---|---|
| DSH 模块与依赖分析（含 file:line） | 本报告 §2（三份审计原始数据已并入） |
| 复用与许可证矩阵 | 本报告 §3 |
| 目标架构与接口草案 | 本报告 §4 + `hands-p0/hands/{protocol,grants,providers,world,engine}.ts`（可运行形态） |
| Hands-P0 样机 | `hands-p0/`（README 有运行方式） |
| 自动化测试与失败证据 | `hands-p0/tests/p0.spec.ts`（16 通过）、`hands-p0/evidence/`（日志 + tree-kill 发现 + 诊断脚本） |
| S03 集成依赖清单 | 本报告 §6 |
| 下一阶段建议 | 本报告 §7 |
