# ZhiYi Hands — 知弈独立用户态执行引擎（预研样机）

ZhiYi Hands 是知弈 AgentOS 的**独立执行组件**：接收版本化的执行请求，在受限的用户态环境中执行文件操作与 Shell 命令，返回可对账的执行收据。它**不含 LLM、不含 Planner、不含第二套任务调度**——上游决策永远属于知弈 Runtime，Hands 只做"被约束地执行"。

执行基座逐字复用 DeepSeek Harness（DSH，MIT）的成熟实现（文件系统、进程树、Windows Job/ACL），通过 Hands 自有的 **Execution World 边界**隔离，可整体替换底层执行实现。

> **状态**：预研样机（PR-HANDS-00 / PR-HANDS-01），46/46 测试通过。不自评生产可用；报告见 `reports/`。

---

## 一、设计

### 1.1 分层架构

```
调用方（知弈内核 / 测试 / CLI）
        │  HandsExecutionRequest（协议 v"1"）
        ▼
┌─────────────────────────────────────────────────────┐
│  引擎层  hands/engine.ts                             │
│  校验协议 → 拒绝内联权限 → Grant 鉴权 → 限额解析      │
│  → 分发到唯一能力处理器 → 封章收据（sha256 checksum） │
├─────────────────────────────────────────────────────┤
│  授权层  hands/grants.ts          协议层 hands/protocol.ts │
├────────────── Execution World 边界（hands/providers.ts）──┤
│  FilesystemProvider │ ProcessProvider │ ResourceProvider │
│  （接口在 hands/；DSH 与自研实现都以 Provider 身份插入） │
├─────────────────────────────────────────────────────┤
│  World 实现                                          │
│  • DSH World（hands/world.ts）——默认                 │
│    ├ confinement:'none'  受围栏 fs + 普通 shell      │
│    └ confinement:'acl'   受围栏 fs + 受限令牌 shell  │
│  • 任意自研/远程 World ——同一接口，协议不变          │
└─────────────────────────────────────────────────────┘
```

### 1.2 核心设计决策

| 决策 | 内容 | 理由 |
|---|---|---|
| **Execution World 边界** | 引擎与协议层只依赖 `hands/providers.ts` 的四个接口；`hands/world.ts` 是**唯一**接触 cordis/DSH 类型的文件 | 更换底层执行实现 = 换一个 World，协议与收据不变（已用三组互换实测：fs 后端、shell 种类、DSH↔自研 provider） |
| **保留最小 Cordis** | 沿用 DSH vendored 的 MIT IoC 容器（约 10 个源文件）作为服务装配运行时 | 对比过"直接提取"（需重写容器语义）与"自行适配"（全部重写）；保留容器是保真度最高、改动为零的路线 |
| **DSH 源码逐字直用** | `vendor/` 87 个 `.ts` 与上游 100% 逐字一致（sha256 记录于 `vendor/PROVENANCE.json`），所有适配经公开接口/钩子完成 | 升级 = 重拷贝 + 重跑清单；零 vendor 修改使差异审计 trivial |
| **授权即引用** | 请求只携带 `{grantId, workspaceId}` 系统签发引用；`input` 中出现任何权限关键字（allowedRoot/sandbox 等，递归检查）直接拒绝 | 镜像知弈 `LocalRuntimeExecutionRequest.reject_inline_authority` 合同 |
| **收据自证** | 每张收据含 `checksum = sha256(canonicalJson(全部字段))`；`startedAt≤completedAt`；`failed ⇔ error` 存在 | 调用方离线即可验伪；对齐知弈 provenance_checksum 纪律 |
| **fail-closed** | Job 不可用 → 拒绝装配且每次 spawn 前复检拒绝；ACL runner 损坏 → `SANDBOX_UNAVAILABLE` 失败收据；shell 可执行不可验证 → 拒绝装配 | 封死 DSH 上游唯一的静默降级路径（taskkill fallback）与一切"降级继续跑" |
| **两条执行路径明确分离** | `confinement:'none'`（默认，P0 语义）与 `confinement:'acl'`（OS 级隔离档）；组合守卫拒绝 `acl×danger-full-access`、`acl×bash` 等中间态 | 隔离档位是显式选择，不存在隐式降级 |

### 1.3 两条执行路径（PR-HANDS-01，均已实测）

| | `confinement: 'none'`（默认） | `confinement: 'acl'` |
|---|---|---|
| fs 写边界 | `SandboxedFileSystem` 策略围栏（可信代码内重规范化+容含检查，拒 TOCTOU 于应用层） | 同左（fs 能力共用） |
| Shell 进程 | 原生 PowerShell 5.1（策略钉扎），Windows Job Object 整树管理 | 同一 shell 经 **WRITE_RESTRICTED 受限令牌 + 能力 SID ACE** 运行：工作区外写被**操作系统**拒绝；子进程创建被 OS 拒绝（无孙进程逃逸面，多进程命令不可用） |
| 超时/取消 | Job 整树终止（kill-on-close），进程表实测无残留 | 同左（受限链整体在 Job 内） |
| 典型用途 | 常规工具执行（低风险/已授权工作区内） | 高风险命令的强隔离档 |

### 1.4 Shell 可执行策略（hands/shell-policy.ts）

- 隐式解析只认两处**原生**根：`%SystemRoot%\...\WindowsPowerShell\v1.0\powershell.exe` → `%ProgramFiles%\PowerShell\7\pwsh.exe`；**永不查 PATH**。
- **MSIX 执行别名一律拒绝**（路径段含 `WindowsApps` 或 realpath 回落到 store 树）——P0 实测 Store pwsh 的孙进程会逃逸 Job，故从源头封禁（本机真实别名的拒绝已入测试）。
- 只接受 powershell.exe / pwsh.exe 家族；摘要（sha256+size）随收据发布。

### 1.5 独立执行服务（PR-HANDS-02，回环 HTTP + 知弈资源 HMAC）

Hands 可作为**独立进程服务**运行（`hands/service-main.ts --config <json>`），入口管线：

```
资源 HMAC 鉴权 → 信封校验（含内联权限拒绝）→ 服务端授权准入 → 账本认领(fsync)
→ 202 + 异步派发（流式事件）→ 回执先落盘 → 终态可观测
```

- **鉴权**（hands/auth.ts）：与知弈 local-runtime 同一签名纪律——`HMAC-SHA256(sha256(secret), "METHOD\nPATH\nTS\nNONCE\nBODY_SHA256")`，±300s 时钟窗，nonce 防重放（409 REPLAY_REJECTED），定长时间比较；`Idempotency-Key` 头必须与信封一致；请求体上限 8MB。
- **准入权威在服务端**（hands/grant-store.ts）：grantId 只是引用；调用方身份 = 签名凭据（客户端自报无效）；七类拒绝（NOT_FOUND/CALLER/WORKSPACE/REVOKED/EXPIRED/ROOT/CAPABILITY）；grants 文件 mtime 热加载。准入结果镜像进引擎纵深复核（grants.install）。
- **执行账本**（hands/ledger.ts）：追加式 JSONL 每行 fsync；幂等键 = (callerId, key)，同键同摘要返回既有记录、异摘要 409；崩溃对账二分——派发前崩溃→FAILED `HANDS_ABANDONED_BY_RESTART`（可重试），执行中崩溃→保守 **UNKNOWN**（永不自动重跑、不铸回执）；撕裂尾行容错。
- **事件流**（hands/events.ts）：accepted/started/stdout.delta/stderr.delta/completed/failed/cancelled/unknown，单调序列，4KB 增量上限，256KB 环形截断（生命周期事件永不丢），`afterSequence` 分页。
- **取消与断连**：cancel 是显式指令（cancelRequested 标记 → CANCELLED 终态；终态后 409）；客户端断连**永不**改变执行结果（派发与响应生命周期解耦，已实测中途 abort → 照常 COMPLETED）。
- **边界**：默认只绑回环（127.0.0.1/localhost/::1，其余拒绝启动）；workdir 越界拒绝（HANDS_WORKDIR_OUT_OF_WORKSPACE）；秘密不进任何响应/日志/账本（三面扫描测试）。

---

## 二、项目结构

```
zhiyi Hands/
├── hands/                     ← 自研代码（Hands 主体，无 DSH 类型泄漏）
│   ├── protocol.ts            版本化协议：请求/收据校验、拒绝内联权限、canonicalJson+checksum
│   ├── grants.ts              Grant 登记簿与鉴权（六种错误码镜像知弈 grants 语义）
│   ├── providers.ts           Execution World 边界：四个 Provider 接口 + 身份/沙箱事实类型
│   ├── engine.ts              引擎：校验→鉴权→限额→分发→封章；shell 收据附 executedBy/sandbox
│   ├── shell-policy.ts        Shell 可执行策略（钉原生/拒 MSIX/摘要）
│   ├── world.ts               DSH World 适配器：JobGuarded 守卫、ACL 装配、策略服务 stand-in
│   ├── native-fallback.ts     自研第二 ProcessProvider（零 DSH，taskkill 树杀；Provider 可换性证明）
│   ├── auth.ts                知弈资源 HMAC 镜像（签名串/头/时间窗/nonce/定长比较）
│   ├── keys.ts                凭据存取与原子轮换（秘密只进内存）
│   ├── grant-store.ts         服务端授权 store（七类拒绝/调用方与根绑定/热加载）
│   ├── ledger.ts              追加式执行账本（fsync/幂等槽/崩溃对账/UNKNOWN）
│   ├── events.ts              有界事件总线（单调序列/增量上限/环形截断）
│   ├── service.ts             服务内核 handle() + 回环 HTTP 包装 + 准入/派发/取消管线
│   ├── service-main.ts        CLI 入口（--config 独立进程；READY 行；测试故障注入点）
│   ├── index.ts               组装入口（createStandaloneHands 一行成套）
│   └── cli.ts                 无 LLM 演示 CLI（demo / exec "<命令>"）
├── vendor/                    ← DSH 逐字提取子集（MIT，87 文件 100% verbatim）
│   ├── packages/fs|subprocess|sandbox|shell|util|llm|native/...   按上游 <组>/<包>/src 嵌套
│   ├── packages/stubs/        自研最小类型桩（dsh-session / dsh-sandbox-policy / dsh-skill）
│   ├── cordis-src|cosmokit-src|schemastery-src                    最小 IoC 容器及其依赖
│   ├── tsconfig.base.json     runner 子进程的 tsx 解析映射（路径深度与上游一致）
│   ├── PROVENANCE.json        上游 commit、逐文件 sha256、verbatim 标记、自研桩清单
│   └── LICENSE                MIT 许可证副本
├── tests/                     ← 93 项测试（真实进程/真实文件系统/真实 ACL/真实独立进程崩溃）
│   ├── p0.spec.ts             P0 基线回归 16 项（六目标映射）
│   ├── shell-policy.spec.ts   Shell 策略 11 项（真实 MSIX 拒绝/身份入收据/装配守卫）
│   ├── adversarial.spec.ts    对抗 11 项（junction/8.3/守卫失效/spill/过期/收据防篡改）
│   ├── sandbox-acl.spec.ts    ACL 隔离 8 项（OS 级拒绝/私有 temp/残留回撤/树清理）
│   ├── service-auth.spec.ts   服务鉴权 26 项（签名/nonce/时间窗/准入七拒/内联权限/泄漏扫描）
│   ├── service-ledger.spec.ts 账本 12 项（幂等/并发/崩溃对账/取消/断连/热加载）
│   ├── service-events.spec.ts 事件流 5 项（顺序/上限/截断/分页）
│   ├── service-crash.spec.ts  真实独立进程崩溃恢复 4 项（故障注入/SIGKILL/重启重放）
│   ├── service-client.ts      与知弈同构的签名测试客户端
│   └── setup-resolve-shim.ts  vitest 环境 import.meta.resolve 垫片（生产路径不受影响）
├── evidence/                  运行日志、失败证据与诊断脚本（含 Store pwsh 逃逸取证）
├── reports/                   PR-HANDS-00 预研 / PR-HANDS-01 可信基线 / PR-HANDS-02A·02B·完整验收
├── package.json / tsconfig.json / vitest.config.ts
└── README.md
```

---

## 三、实现的工具（能力词汇表）

引擎当前实现 **5 个能力**（`capabilityId` 闭集），全部经协议统一入口执行并产出同构收据：

### 3.1 `fs.read` — 读文件

- **输入**：`{ path }`（工作区内相对/绝对路径）
- **输出**：`{ path, text, bytes }`
- 行为：UTF-8 文本读取；读不设围栏（所有档位允许读）。

### 3.2 `fs.list` — 列目录

- **输入**：`{ path }`
- **输出**：`{ path, entries: [{name, type: file|directory|other, size?}] }`
- 行为：仅元数据，不读内容。

### 3.3 `fs.write` — 写文件（可带守卫）

- **输入**：`{ path, content, createIfAbsent?, expectedVersion? }`
- **输出**：`{ path, operation: create|update, version, bytesWritten }`
- 守卫语义（乐观并发，DSH 原生）：`createIfAbsent` 已存在则拒（`FS_NOT_OBSERVED`）；`expectedVersion` 不匹配则拒（`FS_STALE_VERSION`，retryable）；缺省为无条件写。
- 原子性：临时文件 + 原子替换（Windows 下保留目标 DACL）；per-target FIFO 锁串行化并发写。

### 3.4 `fs.patch` — 字面量编辑

- **输入**：`{ path, oldText, newText, replaceAll?, expectedVersion? }`
- **输出**：`{ path, version, bytesBefore, bytesAfter }`
- 行为：精确字面替换（行尾归一化后匹配）；非 `replaceAll` 时多处命中报 `FS_AMBIGUOUS_EDIT`。

### 3.5 `shell.exec` — 执行 Shell 命令（PowerShell）

- **输入**：`{ command, workdir? }`；**限额**：`{ timeoutSeconds?, maxStdoutBytes?, maxStderrBytes? }`
- **输出**：

```jsonc
{
  "exitCode": 0, "signal": null,
  "timedOut": false, "aborted": false,        // first-cause 互斥分类
  "stdout": { "text": "...", "truncated": false, "spillPath": "..." },  // 截断保留尾部，全量落 spill 文件
  "stderr":  { "text": "...", "truncated": false },
  "sandbox": { "mode": "workspace-write", "denied": false, "enforcement": "partial" },  // 仅 ACL 档
  "executedBy": {                              // 实际执行者身份（收据级证据）
    "executable": { "path": "C:\\Windows\\...\\powershell.exe", "sha256": "…", "sizeBytes": 454656, "source": "native-windows-powershell" },
    "confinement": "none|acl",
    "jobContainment": "windows-job|native-fallback"
  }
}
```

- 语义：非零退出是**正常完成**（结果即证据）；超时=整树终止+`timedOut:true`；调用方中止=`cancelled` 收据；基础设施失败（如 ENOENT）=failed 且**绝不伪造成功**。
- 每命令新进程（pwsh `-NoLogo -NoProfile -NonInteractive -Command`，UTF-8 编码头兼容 PS 5.1 OEM 码页），进程树由 Windows Job Object kill-on-close 管理。

### 3.6 授权与收据（所有能力共用）

- **Grant**（`hands/grants.ts`）：`{grantId, workspaceId, canonicalRoot, allowedCapabilities, ttl?}`；六种失败码——`GRANT_NOT_FOUND / WORKSPACE_MISMATCH / GRANT_ROOT_MISMATCH / GRANT_REVOKED / GRANT_EXPIRED / CAPABILITY_DENIED`（镜像知弈 local-runtime grants 服务）。
- **收据**：`status ∈ {completed, failed, cancelled}`、完整 identity 回显（runId/stepId/attemptId/commitId）、`idempotencyKey`、 sanitized error `{code, retryable, message}`、`checksum`。
- **错误码词汇**：授权族 + `FS_*`（透传 DSH 语义）+ `HANDS_*`（协议/取消/内联权限）+ `HANDS_SHELL_*`（策略）+ OS 原生码（如 ENOENT）原样透传。

### 3.7 Provider 层（可替换实现清单）

| Provider 接口 | 现有实现 | 说明 |
|---|---|---|
| `HandsFilesystemProvider` | `dsh-sandboxed-fs`（默认）/ `dsh-local-fs`（无围栏对照） | Sandboxed↔Local 的互换即"围栏开关" |
| `HandsProcessProvider` | `dsh-shell-pwsh`（默认）/ `dsh-shell-bash` / `dsh-shell-pwsh+acl`（受限档）/ `native-fallback-powershell`（自研零 DSH） | 同协议同收据，已互换实测 |
| `HandsResourceProvider` | `hands-default-resource` | 限额收敛（默认 120s/64KB，上限 600s/64MB） |
| （沙箱后端） | vendored `sandbox-windows-acl`（受限令牌+能力 SID） | 经 `LocalSandboxProvider` 装配，Job 组合实测 |

---

## 四、运行

```bash
pnpm install        # node-pty 构建脚本被 pnpm 策略拒绝属预期（仅类型引用）
pnpm typecheck      # hands + tests + vendor 全量（严格度与 DSH 上游等价）
pnpm test           # 93 项：真实 PowerShell / Job Object / ACL / 独立进程服务，forks 池
pnpm demo                       # 无 LLM 全流程演示：读写/补丁/越界拒绝/授权失败/超时/Provider 换装
pnpm run run:exec 'Write-Output "hi"'   # 单命令走完整协议（签发 Grant→执行→收据）
pnpm exec tsx hands/service-main.ts --config <service.config.json>
                                 # 独立执行服务（回环 HTTP + 资源 HMAC + 账本；配置形状见文件头注释）
```

Node ≥ 24.9；测试与 ACL 套件仅支持 Windows（ACL 套件在专用 `.acl-test-env/` 运行并自动清理，不触碰真实工作区安全描述符）。

## 五、测试矩阵（93/93）

| 套件 | 数量 | 覆盖 |
|---|---|---|
| `p0.spec.ts` | 16 | 无 LLM 读写、完整采集、超时/取消/树杀、越界拒绝、身份与收据、Provider 三组互换 |
| `shell-policy.spec.ts` | 11 | 真实 MSIX 别名拒绝、PATH 污染免疫、收据身份、装配守卫（Job 探针失败/acl×danger/acl×bash） |
| `adversarial.spec.ts` | 11 | junction/8.3 走私、守卫中途失效 fail-closed、Job 基础设施错误、超时进程表清理、spill 降级、Grant 过期、坏 workdir ENOENT、收据防篡改、abort→cancelled |
| `sandbox-acl.spec.ts` | 8 | 工作区内/外写对照、junction 走私 OS 拒、受限档无子进程面、私有 temp 精确授予、dispose 回收+standing ACE 残留实证、受限档超时清理、runner 损坏 fail-closed |
| `service-auth.spec.ts` | 26 | HMAC 全失败族（错钥/篡改 body·path/时间窗双向）、nonce 重放 409、新 nonce×同幂等键→既有执行、准入七拒、内联权限三通道、workdir 越界、回环拒绝、秘密三面扫描 |
| `service-ledger.spec.ts` | 12 | 幂等单副作用、同键异摘要 409、10 路并发恰一次、崩溃对账二分（ABANDONED/UNKNOWN）、回执跨重启逐字节一致、撕裂尾行、取消语义、断连免疫、grants 热加载 |
| `service-events.spec.ts` | 5 | 事件顺序与无空洞序列、增量上限零丢失、400KB 环形截断（生命周期不丢）、afterSequence 分页、策略失败事件 |
| `service-crash.spec.ts` | 4 | 真实独立进程：afterClaim/afterStarted 故障注入、真实 SIGKILL→UNKNOWN、重启后同 nonce 重放不重跑 |

## 六、已知限制与安全边界（诚实声明）

- fs 写围栏是可信代码内的策略检查（DSH 语义），非内核边界；残余 TOCTOU 为上游已接受威胁模型。OS 级写隔离仅在 `confinement:'acl'` 档（`enforcement:'partial'`：读/网络/硬链接别名不在保证范围）。
- ACL 档下受限令牌**无法派生子进程**（Windows 令牌语义实测）——多进程命令在该档不可用。
- zh-CN 系统上 DSH 英文拒绝签名不命中 `sandbox.denied` 装饰位（OS 拒绝本身有效；服务路径补充 zh-CN 外观标注，**永不作为唯一隔离判据**）。
- 服务 nonce 表为进程内存级（与知弈 local-runtime 现状同级）；跨重启防重放由幂等键承担（已实测）。账本为单文件 JSONL 全量重放；事件流为内存态（截断语义引导回退回执）。**不宣称 exactly-once 外部副作用**——执行中断一律保守 UNKNOWN，等待对账。
- 本阶段不扩大隔离能力安全承诺；不对真实用户工作区做破坏性 ACL 测试；失败不降档。
- Store pwsh 逃逸 Job 的根因与缓解记录：`evidence/tree-kill-store-pwsh-escape.md`。

## 七、来源、许可证与报告

- 上游：`deepseek-ai/deepseek-harness @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（MIT）。vendored 87 文件逐字一致，见 `vendor/PROVENANCE.json`；外部依赖（koffi/chokidar/undici/yaml）均 MIT。
- 本项目为知弈预研工作区：不提交、不推送、不接入知弈正式 Runtime；知弈主仓库（kinlin）零修改。
- 报告：`reports/PR-HANDS-00-预研报告.md`（模块审计/许可证矩阵/架构草案）、`reports/PR-HANDS-01-可信用户态执行基线.md`（shell 策略/ACL 实测/对抗证据/HANDS-02 接口约束）、`reports/PR-HANDS-02A-可信执行入口实施报告.md`、`reports/PR-HANDS-02B-执行账本与故障对账实施报告.md`、`reports/HANDS-02-完整验收报告.md`。
