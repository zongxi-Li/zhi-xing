# HANDS-02 — 完整验收报告（独立执行服务）

> 状态：**SELF-TESTED**（自测试全绿；不自行宣布独立 ACCEPT）
> 日期：2026-10-28
> 上游分报告：[PR-HANDS-02A-可信执行入口实施报告.md](PR-HANDS-02A-可信执行入口实施报告.md) · [PR-HANDS-02B-执行账本与故障对账实施报告.md](PR-HANDS-02B-执行账本与故障对账实施报告.md)

---

## 1. 交付总览

Hands 由"进程内执行库"升级为**独立运行的用户态执行服务**：

```
知弈内核（或任意签名调用方）
   │  HTTP 回环 · 资源 HMAC（与知弈 local-runtime 同一签名纪律）
   ▼
┌────────────────────────────────────────────────────────────┐
│ HandsService（hands/service.ts）                            │
│  鉴权 → 协议校验 → 服务端授权准入 → 账本认领(fsync) → 异步派发 │
│  GET /v1/health · POST /v1/executions · GET /{id}           │
│  GET /{id}/events?afterSequence · POST /{id}/cancel         │
├────────────────────────────────────────────────────────────┤
│ ExecutionLedger（ledger.jsonl，追加+fsync，重启重放+对账）    │
│ ExecutionEventBus（单调序列，增量上限，环形截断，生命周期不丢） │
├────────────────────────────────────────────────────────────┤
│ HandsEngine（不变）＋ 流式 hooks 泵（服务专用路径）           │
│ Execution World（不变：DSH 源码直用 + Job 守护 + 可选 ACL）   │
└────────────────────────────────────────────────────────────┘
```

### 新增/修改文件（全部自研 hands/ 层与 tests/，vendored 零改动）

| 文件 | 角色 |
|---|---|
| `hands/auth.ts` | 知弈资源 HMAC 逐字节镜像：canonical 串、HMAC-SHA256(sha256(secret))、±300s 窗、nonce 防重放、定长时间比较 |
| `hands/keys.ts` | 多凭据存取 + 原子轮换 + 文件形状校验（秘密只进内存） |
| `hands/grant-store.ts` | 服务端授权 store（七类拒绝、调用方/根/工作区绑定、mtime 热加载） |
| `hands/ledger.ts` | 追加式 JSONL 账本（claim/state/receipt/unknown 行，每行 fsync，重放+撕裂容错+对账） |
| `hands/events.ts` | 有界事件总线（8 类事件、4KB 增量上限、256KB 环、截断标志） |
| `hands/service.ts` | 传输无关内核 handle() + node:http 回环包装 + 完整准入/派发/取消管线 |
| `hands/service-main.ts` | CLI 入口（`--config` 独立进程运行，READY 行，优雅停机，测试故障注入点） |
| `hands/engine.ts`（改） | 流式 hooks 路径（服务专用，非 hook 调用方走原 DSH 前台路径不变）；shell workdir 工作区边界 + `HANDS_WORKDIR_OUT_OF_WORKSPACE` |
| `hands/providers.ts`（改） | 观察者读取器与 hooks 类型（纯类型扩展） |
| `hands/world.ts`（改） | observed 读取器映射；zh-CN OS 拒绝文本的**外观性**标注（仅补充 denied 标志，隔离事实以 OS 级文件效果为准） |
| `hands/grants.ts`（改） | `install()`：服务端准入镜像进引擎纵深复核 |
| `hands/protocol.ts`（改） | 新错误码 `HANDS_WORKDIR_OUT_OF_WORKSPACE` |
| `tests/service-client.ts` | 与知弈同构的签名测试客户端 + 轮询助手 |
| `tests/service-auth.spec.ts` | 26 用例（02A） |
| `tests/service-ledger.spec.ts` | 12 用例（02B 进程内） |
| `tests/service-events.spec.ts` | 5 用例（事件流） |
| `tests/service-crash.spec.ts` | 4 用例（**真实独立进程**崩溃/恢复） |

## 2. PRD 验收口径逐条对照（18 类实测场景）

| # | PRD 场景 | 实测用例 | 结果 |
|---|---|---|---|
| 1 | 合法签名请求全链路 | auth: happy path（真实进程→COMPLETED+密封回执+executedBy） | ✅ |
| 2 | 错误密钥/签名 | auth: 错秘密 401、签名后改 body 401、改 path 401、未知凭据 401、无头 401 | ✅ |
| 3 | nonce 重放（同 nonce→409） | auth: REPLAY_REJECTED | ✅ |
| 4 | 新 nonce 重试同幂等键→既有状态 | auth: 200 同 executionId，tick 恰 1 | ✅ |
| 5 | 时间戳过期/未来 | auth: ±400s 双向 401 | ✅ |
| 6 | 未授权 grant | auth: 七类准入拒绝各一例（含 CALLER_NOT_AUTHORIZED 交叉凭据） | ✅ |
| 7 | 内联授权/降级 | auth: workspaceroot/sandbox/sandboxPolicy 三通道 400 HANDS_INLINE_AUTHORITY | ✅ |
| 8 | 回环绑定拒绝 | auth: host=0.0.0.0 启动抛错 | ✅ |
| 9 | 密钥不泄漏 | auth: 响应体+日志+账本字节三面扫描零命中 | ✅ |
| 10 | 幂等重放单副作用 | ledger: 同键同摘要→既有记录；真实文件计数 | ✅ |
| 11 | 同键异摘要冲突 | ledger: 409 IDEMPOTENCY_KEY_CONFLICT | ✅ |
| 12 | 并发认领恰一次 | ledger: 10 路并发 1×202+9×200 | ✅ |
| 13 | 故障注入崩溃（认领后/启动后） | crash: afterClaim→FAILED 可重试；afterStarted→UNKNOWN 永不重跑 | ✅ |
| 14 | 真实 SIGKILL 执行中 | crash: kill('SIGKILL')→重启→UNKNOWN | ✅ |
| 15 | 重启状态恢复+回执持久 | ledger: 重启后回执逐字节一致；crash: 重启后重放既有记录 | ✅ |
| 16 | 取消 vs 终态区分 | ledger: cancelRequested 标记、CANCELLED 终态、终态后 409、信封不一致 400 | ✅ |
| 17 | 准入中途撤销/过期（热加载） | ledger: grants 文件 mtime 翻转→下一请求 GRANT_REVOKED；auth: 静态过期 GRANT_EXPIRED | ✅ |
| 18 | 断连不改变结果 | ledger: 真实 HTTP abort→COMPLETED、tick+1 | ✅ |
| 附 | workdir 越界拒绝（服务级） | auth: 202→FAILED `HANDS_WORKDIR_OUT_OF_WORKSPACE` 回执 | ✅ |
| 附 | 事件顺序/序列/上限/截断/分页 | events: 5 用例（含 400KB 截断、策略失败事件、404） | ✅ |

## 3. 全量回归（最终）

```
pnpm test  →  Test Files 8 passed (8) · Tests 93 passed (93) · exit 0
```

- 既有 46 用例（p0 16 / shell-policy 11 / adversarial 11 / sandbox-acl 8）全部保持绿色——引擎扩展采取**双路径**设计：非 hook 调用方仍走 DSH 前台原生首因分类，零行为漂移。
- 新增 47 用例（auth 26 / ledger 12 / events 5 / crash 4）全绿。
- `pnpm typecheck`（tsc --noEmit）零错误。

## 4. 安全边界保持（不扩大承诺）

- **本阶段未扩大任何隔离能力的安全承诺**。ACL 沙箱的既有限制照旧（受限令牌下子进程创建被 OS 整体禁止——强于"写约束"；standing ACE 不回收；MSIX/Store pwsh 逃逸靠 shell 策略拒绝 WindowsApps 路径）。
- **未对真实用户工作区做破坏性 ACL 测试**；所有测试使用独立临时工作区与临时持久化目录（mkdtemp），不触碰业务数据。
- **字符串匹配永远不是唯一隔离判据**：zh-CN 拒绝文本（"访问被拒绝"）仅作 denied 标志的外观性补充；所有隔离断言以 OS 级文件存在性/进程表为准。
- 失败不降档：无任何"执行失败→降低安全档位重试"路径；策略拒绝即终态 FAILED。
- 知弈主仓库（kinlin_ai）零改动、未提交、未推送、未部署。

## 5. 事故记录（过程透明）

1. **engine workdir 边界同步死循环（本 PR 引入，已修复）**：`assertWorkdirInsideWorkspace` 对不存在盘符的祖先回溯在根处不终止，同步阻塞事件循环（测试超时机制因此完全失效，回归表现为整场卡死）。定位：隔离运行 adversarial 单文件 → 二分测试名模式 → 锁定 D10 nonexistent-workdir 用例。修复：回溯加 `dirname(probe)===probe` 终止条件，让 realpath 对不存在根给出诚实 ENOENT。该修复使 D10 恢复"基础设施失败→FAILED 回执"语义。
2. service.ts 初版三处自评嫌疑（私有字段 Reflect.set 死代码、ESM require、事件路由被裸 GET 遮蔽）——全部修复后才进入测试。
3. 早期一次全量回归"假失败"（tail 管道缓冲导致日志为空 + 后续真实卡死混合）——以直写日志文件 + verbose reporter 排除工具因素后再定位真因（即事故 1）。

## 6. 未尽事项（如实）

- nonce 表为进程内（与知弈 local-runtime 现状同级）；跨重启防重放由幂等键承担（已测）。持久 nonce 存储为后续项。
- 账本为单文件 JSONL 全量重放；无分段/归档。事件流为内存态，重启后不补发（截断语义引导回退回执）。
- 崩溃注入为两个确定性切点 + 真实 SIGKILL，未穷举全部崩溃位（fsync 中途的后果已由撕裂尾行用例覆盖）。
- 正式密钥分发/轮换编排/KMS、部署形态：本阶段不做，不虚报。
- 仅报告 **SELF-TESTED**；独立验收（ACCEPT）由调用方决定。

## 7. 结论

PR-HANDS-02 的两项子目标（02A 可信执行入口、02B 执行账本与故障对账）均已按 PRD 口径实现并以真实系统效果验证：签名纪律与知弈实测实现一致；权威在服务端；崩溃语义诚实（副作用未发生→可重试失败，可能发生→保守 UNKNOWN）；幂等与 nonce 各司其职；断连与取消互不僭越；事件有界有序。既有 46 项基线能力零回归。总状态 **SELF-TESTED，93/93 全绿**。
