# PR-HANDS-01 ｜ ZhiYi Hands 可信用户态执行基线

**日期**: 2026-10-28 ｜ **基线**: PR-HANDS-00（16/16）
**工作区**: `C:\Users\LZX\Desktop\zhiyi Hands\hands-p0\`（隔离，无 git，不提交不推送）
**知弈主仓库**: `C:\Users\LZX\Desktop\kinlin_ai` — **本预研零修改、零接入**。注：验证时点该仓库存在未提交修改（`.config/env/windows.example`、`.gitignore`、`apps/agent/Dockerfile` 等），为用户自身的 S03 开发活动（PR-HANDS-00 验证时点为干净），与本预研无关。
**上游**: deepseek-ai/deepseek-harness @ `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（MIT）

**总体结果**: P0 16 项回归 + 新增 30 项 = **46/46 通过**；typecheck 干净；tsx 生产路径与 vitest 双通道验证。隔离结论全部来自真实系统级测试（文件系统状态、进程表、ACL/DACL 实测），非策略配置宣称。

标记：**VERIFIED**（有运行证据）/ **PROPOSED**（设计未实现）/ **BLOCKED**（受阻有据）。

---

## 一、A. P0 基线固定（VERIFIED）

| 项 | 结果 | 证据 |
|---|---|---|
| 16 项 P0 回归 | 收紧默认（Job 守卫 + shell 策略）下仍 **16/16** | `evidence/pr-hands-01-test-run.log` |
| 类型检查 | 干净（tsc --noEmit，含全部 vendor 依赖链） | `pnpm typecheck` |
| 依赖锁定 | pnpm-lock.yaml 未变除新增 `yaml@2.9.1`（MIT，仅 acl-skill 前置） | lockfile diff |
| Vendored 来源 | **87 个 .ts 文件与上游 100% 逐字一致**（sha256 逐一比对），布局差异仅为恢复上游 `src/` 嵌套 | `vendor/PROVENANCE.json`（87 条目 + 自研 stub 清单） |
| 许可证 | 提取闭包全 MIT（DSH 源码 + koffi/chokidar/undici/yaml）；stub 为自研并标注来源 | P0 报告 §3 + PROVENANCE `stubs_owned_by_hands` |
| 升级路径 | 重跑 PROVENANCE 生成脚本即可 diff 上游新 commit；零 vendor 内容修改意味着 rebase = 重拷贝 + 重跑清单 | 同上 |

新增 vendored（相对 P0 的 70 文件）：`sandbox/sandbox-local`（8）、`sandbox/sandbox-windows-acl`（11）、`shell/pwsh-sandbox`、`native/system/packages/entry`（landlock-run 入口，127 行，Windows 上永不触发探测）。**vendor 内容零修改**——所有适配通过公开接口/钩子完成（见 §2）。

---

## 二、B. Shell 执行策略收紧（VERIFIED）

### 实际修改及源码位置（全部在自研 `hands/` 层，vendor 零改动）

| 修改 | 位置 | 内容 |
|---|---|---|
| Shell 策略模块（新） | `hands/shell-policy.ts` | 候选解析钉死两处原生根（System32 PS5.1 → Program Files pwsh7），**永不查 PATH**；MSIX 别名双重拒绝（路径段 `WindowsApps` + realpath 回落检查）；仅接受 powershell/pwsh 家族名；sha256+size 摘要 |
| 收据记录执行身份 | `hands/engine.ts`（dispatchShell）、`hands/providers.ts`（`HandsExecutionIdentity`） | `shell.exec` 收据新增 `executedBy: {executable:{path,sha256,sizeBytes,source}, confinement, jobContainment}` 与 `sandbox` 事实 |
| Job fail-closed 守卫 | `hands/world.ts`（`JobGuardedSubprocessRuntime`） | 复用 vendored `probeWindowsJob()`（与上游 `selectContainmentMode` 同一判定函数，`subprocess-local-src/src/index.ts:252-255`）：组合期探测失败→拒绝建 World；每次 spawn 前再探测→失败抛错（fail-closed），**不给上游静默降级到 `child_process+taskkill` fallback 的机会**。探测函数可注入（`jobProbe` 选项，供对抗测试） |
| 执行器 cwd 钉扎 | `hands/world.ts`（三处 executor Config） | `cwd: workspaceRoot`——上游默认 `process.cwd()`（见本轮实测发现 §4.4） |
| ACL 装配守卫 | `hands/world.ts`（`createDshWorld`） | `confinement:'acl'` × `danger-full-access` / × bash → 组装即拒绝 |
| native-fallback 同样携带身份 | `hands/native-fallback.ts` | 构造即摘要其所用 powershell.exe |

### 静默回退排查结论（VERIFIED）

上游存在**唯一**一条静默降级路径：`selectContainmentMode` 在 `probeWindowsJob()` 为假时降级为普通 spawn + `taskkill /T`（best-effort，上游自注）。守卫类在上游判定点**之前**用同一探针拦截，工程上封死该路径（探针同源镜像；若上游将来改判定条件，守卫需同步——已列为升级检查项）。Job 探针通过但 runner 启动失败的情形，上游本身即按基础设施错误**拒绝**（`failInfrastructure`，windows-job.ts:160-177），非降级——实测证实（§4 D10 ENOENT 收据）。

### Shell 对照测试（VERIFIED / 环境受限记录）

- 原生 PS 5.1：全量路径 VERIFIED（默认钉扎对象）。
- pwsh 7（Program Files 原生安装）：本机未安装——`shell-policy.spec.ts` 断言隐式解析会落到 5.1 且摘要与磁盘一致；pwsh 7 路径作为策略第二候选存在，装即生效。**PROPOSED**（待有 pwsh 7 的机器补对照）。
- Store pwsh（MSIX 别名）：**真实拒绝**——本机存在真实别名 `C:\Users\LZX\AppData\Local\Microsoft\WindowsApps\pwsh.exe`，测试断言其被拒（`HANDS_SHELL_MSIX_ALIAS_REJECTED`），含伪装拼写（realpath 回落检查）。VERIFIED。

---

## 三、C. Windows SandboxProvider 挂载（VERIFIED，含两项超出预期的实测发现）

### Provider 装配关系

```
confinement:'acl' 时的执行链（全部 vendored 原件 + 自研胶水）：
engine → SandboxPwshExecutor (vendored, ctx.shell)
        ├─ ctx.sandboxPolicy = HandsSandboxPolicyService（自研 20 行 stand-in，
        │   mode+workspaceRoot+sessionId——sessionId 使 ACL 授权走会话缓存路径）
        ├─ ctx.sandbox = LocalSandboxProvider (vendored)
        │   ├─ windows-acl rung（唯一平台候选，无探测竞态）
        │   ├─ 授权物化：standing 工作区 ACE（S-1-4- 能力 SID，设计上不回收）
        │   │   + 每会话私有 temp 目录 + 独立 temp SID（dispose 回收）
        │   └─ runner argv 经公开 internals.windowsAclRunnerArgs 钉死为上游
        │       source-form 调用式（hands/world.ts aclRunnerInvocation——上游用
        │       import.meta.resolve 解析 workspace 子路径，在 tsx/vitest 别名
        │       环境下不确定；Hands 以确定性路径复刻同一调用式，零 vendor 修改）
        ├─ 受限链：SandboxPwshExecutor 把 pwsh argv 交给 confine() 包裹成
        │   [node, --import data:…(register tsx), runner.ts, --workspace …,
        │    --temp …, --mode workspace-write, --write-sid S-1-4-…, --, pwsh…]
        └─ ctx.subprocess = JobGuardedSubprocessRuntime（自研守卫子类）
            → Job runner 子进程 → ACL runner（CreateProcessAsUserW 受限令牌）→ pwsh
```

Job Object 与 SandboxProvider 组合：**VERIFIED**——受限链整体在 Job runner 的 kill-on-close Job 内执行；超时杀树实测无残留（进程表核对），且收据 `executedBy.jobContainment='windows-job'`。

### 受限令牌与 ACL 的实际约束范围（全部真实系统级断言，`tests/sandbox-acl.spec.ts` 8/8）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 工作区内写 | 允许（真实文件落盘回读） | control case |
| **工作区外写（shell）** | **OS 拒绝**：`Set-Content` 收到 "Access to the path … is denied"（本机 zh-CN："对路径…的访问被拒绝"），目标文件不存在 | D2 |
| junction 走私 | 工作区内 junction 指向外部目录，受限写经其写入 → OS 拒绝，外部文件不存在 | D3 |
| 临时目录语义 | 私有 temp（`%TEMP%\dsh-*`，经 `--temp-write-sid` 授予）**可写**；OS temp 根**不可写** | temp semantics |
| 授权残留/回收 | dispose 后：私有 temp 目录**被删除**、temp ACE 回收；工作区 standing ACE（S-1-4-*）**按设计保留**（icacls 实测含该 SID）；standing-ACE 工作区可正常 rmSync 清理 | dispose/残留 |
| 隔离失败 fail-closed | ACL runner 损坏 → `SANDBOX_UNAVAILABLE` 浮现为 failed 收据，命令未运行 | D5-adjacent |
| ACL 测试环境 | 专用 `.acl-test-env/`（项目内、会话后自动删除），**未触碰任何真实工作区安全描述符** | 测试夹具 |

### 超出预期的实测发现（重要，写入设计事实）

1. **受限令牌下子进程创建被 OS 整体拒绝**（VERIFIED，D4）：`WRITE_RESTRICTED` 令牌的 pwsh 调 `Start-Process` 直接失败（Win32 `Access is denied`）——孙进程**无法被创建**（强于"孙进程被约束"）。安全上更强（无孙进程逃逸面）；能力上受限：**ACL 模式不能运行多进程命令**（npm/构建工具链等）。这不是缺陷而是 Windows 令牌语义；据此 D6 测试改为纯 shell 超时清理（真实残留核对），对抗套件的孙进程树杀测试保留在非 ACL 路径（Job 语义验证）。
2. **zh-CN 消息文化下 DSH 英文拒绝签名不命中**（VERIFIED）：OS 拒绝本身有效（文件不产生），但上游 `DENIAL_SIGNATURES['windows-acl']`（英文子串）无法在中文系统置位收据的 `sandbox.denied` 装饰位。已按硬事实断言（文件状态 + 中英双模式文本）；上游签名表本地化列为 HANDS-02 议题。
3. **`-WindowStyle Hidden` 下 Start-Process 的错误文本不进入采集 stderr**（VERIFIED，tsx/vitest 双通道复现）——拒绝事实以文件级断言为准。

### 已验证 / 未验证的安全保证（诚实边界）

**VERIFIED**（本机实测，专用环境）：工作区外写拒绝（含 junction 别名）；OS temp 根写拒绝、私有 temp 精确授予；受限模式下无子进程逃逸面；dispose 回收 temp 授权；runner 故障 fail-closed；standing ACE 残留范围（工作区目录本身，机器本地、随目录删除消亡）。

**NOT VERIFIED / 设计已声明不保证**（上游文档 + 本轮未测）：读不设限（`enforcement:'partial'`）；NTFS 硬链接别名（上游自报残留）；网络出站不设限；AppContainer-ACL 过的树不可读（Low 完整性）；路径替换 TOCTOU（上游接受的残余）。**本报告不对上述面做安全承诺。**

**BLOCKED**: 无（本轮无目标受阻；pwsh 7 对照为环境缺口而非阻塞）。

---

## 四、D. 对抗测试（30 项新增，全部真实系统效果断言）

| 类 | 测试 | 关键断言（真实效果，非返回码） | 套件 |
|---|---|---|---|
| D1 | fs 越界 + junction 走私 | 外部目标文件不存在；工作区内 junction 对照成功 | adversarial |
| D1 | 8.3 短名别名 | 8.3 拼写的外部路径被拒（8.3 禁用时退化为普通越界仍拒） | adversarial |
| D2 | shell 越界写（ACL） | OS 拒绝文本 + 文件不存在 + 拒后工作区仍可写 | sandbox-acl |
| D3 | 符号链接/junction/别名 | fs 层（重规范化）与 OS 层（ACL）双重实测 | 两者 |
| D4 | 孙进程逃逸 | 非 ACL：Job 树杀后 tasklist 无孙进程；ACL：孙进程创建被 OS 拒（更强） | 两者 |
| D5 | Job runner 崩溃/Job 创建失败 | 守卫中途失效 → failed 收据含 "failing closed" 且输出不含命令产物；组合期探测失败拒建 World；launchWindowsJob 直测基础设施错误路径 | adversarial + shell-policy |
| D6 | 超时/取消后进程清理 | Get-CimInstance 进程表计数归零（非 ACL 与 ACL 两路径） | 两者 |
| D7 | spill 不可写 + 输出上限 | spill 指向普通文件 → 执行仍完成、尾保留、truncated=true、无 spillPath；小预算截断+spill 文件存在 | adversarial + P0 |
| D8 | Grant 撤销/过期/能力不匹配/根不匹配/工作区不匹配/不存在 | 六码逐项 + 过期后 `output` 为 undefined（未执行） | adversarial + P0 |
| D9 | 不受支持的 shell 路径 | 真实 MSIX 别名拒、cmd.exe 拒、不存在拒、PATH 污染不影响解析、acl×danger / acl×bash 组装拒 | shell-policy |
| D10 | 结果未知/回执缺失 | 坏 workdir → failed（透传 OS ENOENT）且无伪造 output；provider 中途抛 → failed + identity/checksum 完整可对账；收据篡改（改 durationMs）→ checksum 不匹配；abort → cancelled 非 completed | adversarial |

---

## 五、过程发现与修复（诚实记录）

1. **vitest 的 SSR 转换缺 `import.meta.resolve`** → runner 探测在测试环境全灭。修复：范围限定的 vite 插件把调用点重写为全局 shim（`tests/setup-resolve-shim.ts`，返回 `file://` URL 与原生语义一致——首版返回裸 Windows 路径导致子进程 `--import` 报 `protocol 'c:'`，已修正）。生产 tsx 路径零影响。
2. **cordis 服务代理穿越 ES 私有字段品牌检查**（`#workspaceRoot`）→ ACL 链首次装配崩溃。修复：策略服务改普通字段（`hands/world.ts` 注释说明）。
3. **执行器默认 cwd=process.cwd()**（上游语义）→ ACL 相对路径写落在进程目录被 OS 拒（表现为"控制案例失败"）。修复：装配钉 `cwd: workspaceRoot`（对 Hands 而言本就正确的语义）。此为 P0 未暴露的隐患，P0 测试从未用相对路径写。
4. B3 测试曾用不存在的 workspaceRoot（cwd 钉扎后 ENOENT）——测试缺陷，已修。

---

## 六、与 HANDS-02 传输层的接口约束

1. **收据即合同**：`HandsExecutionReceipt` 新增 `output.executedBy`（可执行身份三元组 + 隔离/ containment 声明）与 `output.sandbox`（denied/enforcement/runnerFailed）。传输层必须**原样透传**并纳入 checksum 覆盖（已覆盖——canonicalChecksum 序列化全字段）。对账方据此可校验"实际执行者身份"，无需信任 Hands 自述。
2. **错误码词汇表已扩大**：`HANDS_SHELL_{MSIX_ALIAS_REJECTED,NOT_FOUND,NOT_POWERSHELL,UNREADABLE}`、`SANDBOX_UNAVAILABLE`（透传）、OS 原生码（如 ENOENT）原样出现在 `error.code`。传输层的错误分类表需收录；`retryable` 语义不变（授权类 false，取消 true）。
3. **取消/超时语义**：cancelled 收据携带完整 identity+checksum（可对账）；超时是 completed + `timedOut:true`（first-cause 分类）。传输层不得把超时改写为 failed。
4. **confinement 是请求可选项**：HANDS-02 若引入传输层 `securityProfile` 字段，直接映射知弈 `ExecutionSecurityProfile`（host_approved↔'none'，isolated_workspace↔'acl'）；两条路径明确分离（§README），不允许中间态。
5. **尚未实现**：HTTP/HMAC 面、幂等重放存储、流式事件（stdout_delta）——全部留在 HANDS-02，本轮零传输代码。

---

## 七、下一阶段待解决问题（按优先级）

1. **HANDS-02 传输层**：HMAC HTTP 服务面（复用知弈 local-runtime 的 X-Resource-* 方案）+ 幂等重放 + 收据/事件流；把 `executedBy`/`sandbox` 纳入对账投影。
2. **拒绝签名本地化**：上游 DENIAL_SIGNATURES 英文子串在 zh-CN 系统不命中 `sandbox.denied`——给守卫/适配层补本地化签名表或退出码分类（upstream-agnostic）。
3. **ACL 模式能力边界的产品决策**：受限令牌下无法派生子进程（多进程命令不可用）——需要知弈侧决定：接受（高安全档）或研究 CreateProcessAsUser 受限子进程链（上游 runner 内部即如此，可评估对 shell 的开放方案）。
4. **pwsh 7 对照**：装有原生 pwsh 7 的机器补齐 B6 对照（策略已支持，装即生效）。
5. **升级守卫镜像检查**：上游若改 `selectContainmentMode` 判定，`JobGuardedSubprocessRuntime` 的探针镜像需同步（PROVENANCE 重跑 + 守卫单测）。
6. **read-only 模式实测补全**：ACL read-only（无任何写授予）路径未单独建套件（模式存在且装配守卫覆盖组合合法性）。

## 八、自评边界

不自评生产可用。本轮所有隔离结论限定于：本机（Windows 11 26100 x64，zh-CN）、专用测试环境、上述断言覆盖面。未做渗透式验证、并发压测、长时运行验证。知弈正式 Runtime 零接入零修改。
