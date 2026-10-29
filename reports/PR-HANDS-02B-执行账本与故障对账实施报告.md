# PR-HANDS-02B — 执行账本与故障对账实施报告

> 状态：**SELF-TESTED**（自测试通过；不自行宣布独立 ACCEPT）
> 日期：2026-10-28
> 范围：持久化 Execution Ledger（先持久化后执行、终态先落盘再可观测）、幂等键语义、崩溃恢复与 UNKNOWN 保守对账、取消语义、断连免疫、有界事件流、**真实独立进程**故障注入与恢复测试。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 执行前持久化（claim 先于派发，fsync/行） | **VERIFIED** |
| 幂等键唯一性（caller,key）：同键同摘要→同记录不重跑；同键异摘要→409 | **VERIFIED** |
| 并发认领恰一次（10 路并发：1×202 + 9×200，副作用一次） | **VERIFIED** |
| 崩溃对账：派发前崩溃→FAILED `HANDS_ABANDONED_BY_RESTART`（可重试）；执行中崩溃→UNKNOWN `HANDS_RESTARTED_DURING_EXECUTION`（永不自动重试、不铸造回执） | **VERIFIED**（进程内重建 + **真实独立进程**两种途径） |
| 真实 SIGKILL 执行中→重启→UNKNOWN | **VERIFIED** |
| 终态回执先于可观测落盘；重启后 GET 得到逐字节一致回执 | **VERIFIED** |
| nonce 防重放 ≠ 幂等重试（两机制分离） | **VERIFIED**（含跨重启重放用例） |
| 取消：请求态与终生态区分；终态后取消 409；路径/信封不一致 400 | **VERIFIED** |
| 客户端断连不改变结果（真实 HTTP 中途 abort→仍 COMPLETED、副作用恰一次） | **VERIFIED** |
| 事件流：顺序/单调序列/增量上限/环形截断（生命周期事件不丢）/afterSequence 分页/重复订阅 | **VERIFIED** |
| exactly-once 外部副作用 | **不宣称**——保守 UNKNOWN 语义（PRD 明示口径） |

新测试套件：`tests/service-ledger.spec.ts` **12/12**、`tests/service-events.spec.ts` **5/5**、`tests/service-crash.spec.ts`（真实独立进程）**4/4**。

---

## 1. 账本设计 — `hands/ledger.ts`

### 1.1 存储形态

- 每服务实例一个 `dataDir/ledger.jsonl`：**追加式 JSONL，每行写后 `fsyncSync`**（openSync 'a' 持有 fd）。
- 行类型：`claim / state / cancel-requested / receipt / unknown`。
- 启动重放：逐行 `JSON.parse` 重建内存索引；**撕裂尾行（崩溃半写）忽略**；重复 claim 行先到先得。
- 未知请求摘要 = **原始请求体字节的 sha256**（记录绑定到确切字节，而非语义对象）。

### 1.2 状态机

```
RECEIVED → AUTHORIZED → STARTED → COMPLETED | FAILED | CANCELLED | UNKNOWN
                                  （终态；UNKNOWN 亦为终态）
```

- `claim()`：占用 `(callerId, idempotencyKey)` 槽（callerId 来自 HMAC 凭据，非请求体）。同摘要→`{claimed:false}` 返回既有记录；异摘要→`{conflict:true}`。**认领行先于任何派发动作落盘。**
- `attachReceipt()`：终态回执**先持久化**，服务才返回可观测的终态（响应、事件）。
- `markCancelRequested()`：独立的"取消请求"标记，与终态 `CANCELLED` 严格区分。
- `markUnknown()`：基础设施故障（STARTED 之后）→ UNKNOWN + reconciliation 原因；终态后不可再改。

### 1.3 崩溃对账（`reconcile()`，start() 时在接纳流量前执行）

| 崩溃点 | 重放后状态 | 语义 |
|---|---|---|
| claim 后、派发前（RECEIVED/AUTHORIZED） | **FAILED** + 合成回执 `HANDS_ABANDONED_BY_RESTART`（retryable=true） | 无副作用发生；客户端可用**新幂等键**重试 |
| STARTED 中（执行已开始） | **UNKNOWN** + `HANDS_RESTARTED_DURING_EXECUTION`，**不铸造回执** | 副作用可能已发生；永不自动重试；等待人工/上层对账 |
| 撕裂尾行 | 忽略，其余照常重放 | 追加式 + 先到先得使然 |

**不宣称 exactly-once 外部副作用**：执行中断的诚实答案是 UNKNOWN，不是补跑也不是谎报成功。

## 2. 服务层接线 — `hands/service.ts`

- 派发与响应生命周期**解耦**（`void #dispatch()`）：客户端断连、取消、进程崩溃都不改变已派发执行的归宿。
- 派发序：镜像准入授权进引擎注册表（见 02A §2.3）→ AUTHORIZED →（若取消请求已先行到达：直接密封 CANCELLED 回执，零副作用路径）→ STARTED → 引擎执行（流式 hooks 泵入事件总线）→ **回执落盘** → 终态 → 终态事件。
- 派发异常（STARTED 后）：尽力 `markUnknown`；停机竞态（账本已关）下容忍并记日志——下轮启动 reconcile 从最后持久化状态分类，与真实崩溃同一恢复路径。
- `POST /{id}/cancel`：信封 executionId 必须与路径一致（400）；未知 404；已终态 **409 EXECUTION_ALREADY_SETTLED**；否则标记取消请求 + abort 执行控制器。
- `GET /{id}`：完整记录（状态、cancelRequested、callerId、摘要、回执、对账信息）。
- `GET /{id}/events?afterSequence=`：有界事件流快照（§4）。

## 3. 幂等 × nonce：两个机制，各自独立

- **nonce（auth.ts）**：传输级防重放，进程内存，窗口=签名时间+skew。同 nonce 二连→409 REPLAY_REJECTED。
- **幂等键（ledger.ts）**：耐久、跨重启、按 `(callerId, key)` 槽。合法客户端用**新 nonce** 重试同幂等请求：得到**既有执行状态**（200），绝不重跑。
- **跨重启合并验证**（service-crash 第 4 用例）：执行完成→杀进程→重启→**重放完全相同的已签名字节（同 nonce！）**：新进程 nonce 表无记忆→不 409；幂等槽持久→返回既有 COMPLETED 记录，副作用文件仍恰 1 次 tick。两条防线各司其职，无一处混用。

## 4. 有界事件流 — `hands/events.ts`

- 每执行一条单调序列（seq 从 0 严格递增无空洞）。
- 事件类型：`execution.accepted / execution.started / stdout.delta / stderr.delta / execution.completed / execution.failed / execution.cancelled / execution.unknown`。
- 增量上限 `EVENT_DELTA_MAX_BYTES=4KB`（按 2K 字符保守切分）；每执行增量环形预算 256KB，超限从最老增量驱逐并置 `truncated=true`；**生命周期事件永不驱逐**——客户端见截断即按序列缺口回退到耐久回执。
- `afterSequence` 严格大于语义分页；重复订阅幂等。事件为内存态，耐久事实以账本+回执为准。

## 5. 测试证据

### 5.1 tests/service-ledger.spec.ts（进程内真实服务，12/12）

| 用例 | 断言要点 |
|---|---|
| 同键重放 | 202→COMPLETED 后同 body 重发→200 同 executionId；tick 文件恰 1 行 |
| 同键异摘要 | 409 IDEMPOTENCY_KEY_CONFLICT |
| 10 路并发同键 | 恰 1×202 + 9×200 同 id；副作用恰 1 次 |
| 派发前崩溃重建 | 新服务同 dataDir 启动→记录 FAILED + `HANDS_ABANDONED_BY_RESTART`(retryable) |
| 执行中崩溃重建 | STARTED 落盘后重建→UNKNOWN + 原因 + **无回执**；同键重试（异摘要）409、零副作用 |
| 回执跨重启 | 重启后 GET 回执与重启前逐字节相等（toEqual） |
| 撕裂尾行 | 追加非法 JSON 垃圾后重放照常 |
| 取消正路 | 60s 睡眠命令→cancel 200(cancelRequested)→终态 CANCELLED + cancelled 回执 |
| 终态后取消 | 409 EXECUTION_ALREADY_SETTLED |
| 取消信封 | executionId 不匹配 400；未知 404 |
| 断连免疫 | 真实 HTTP fetch 中途 abort→执行照常 COMPLETED、tick 恰 +1 |
| 授权热加载 | grants 文件 mtime 变化→下一请求 GRANT_REVOKED，无重启 |

### 5.2 tests/service-crash.spec.ts（**真实独立进程**，4/4）

服务以 `node + tsx hands/service-main.ts --config <json>` 子进程运行（真实 keys/grants/config 文件）：

| 用例 | 途径 | 断言 |
|---|---|---|
| afterClaim 故障注入 | 配置 `faults.afterClaim`，认领落盘后 `exit(1)`（响应未达客户端） | 连接被撕断；tick=0；重启后同请求→200 既有记录 FAILED/ABANDONED(retryable)；仍 tick=0 |
| afterStarted 故障注入 | 派发后 `exit(1)`（202 已返回） | 重启后 GET→UNKNOWN + RESTARTED_DURING_EXECUTION + 无回执；同键同摘要重试→200 UNKNOWN 记录本体，**不重跑** |
| 真实 SIGKILL | `child.kill('SIGKILL')` 执行中 | 重启后 UNKNOWN（与注入途径完全一致） |
| 重启后同 nonce 重放 | 完成后杀进程，重启，重放**原签名字节** | 非 409；200 既有 COMPLETED；tick 仍 1 |

### 5.3 tests/service-events.spec.ts（5/5）

顺序 accepted→started→deltas→completed 且 seq 严格递增无空洞；stdout/stderr 增量拼回完整输出；9000 字符输出按上限切分且**零丢失**（拼接后 9000 个 x）；~400KB 输出触发环形截断（truncated=true）而生命周期事件全在；`nextSeq-2` 恰 1 条 / `nextSeq-1` 与 `nextSeq` 0 条；非法游标 400；策略失败（工作区外写，FS_SANDBOX_DENIED）终态事件为 `execution.failed`；未知执行 404。

## 6. 语义澄清（与 PRD 口径对齐）

- **非零退出码 ≠ 失败执行**：命令跑完退出 7 是 `completed`（exitCode 是证据）；`failed` 保留给策略拒绝/基础设施失败/超时类。事件测试中故意用一个策略拒绝触发 `execution.failed`。
- **UNKNOWN 不自动重试**：包括"同键重试"在内的一切路径都只会拿回 UNKNOWN 记录本体；重新执行需要**新幂等键 + 运营决策**。
- **取消与断连不同**：取消是显式指令（终态 CANCELLED）；断连不是指令（结果不变）。
- 回执绑定 executionId / 请求摘要 / 调用方身份（callerId 来自签名凭据），合成回执亦走同一 checksum 密封（`grantId='server-side-reconciliation'` 显式标注非客户端来源）。

## 7. 边界与未做

- 账本为**单文件 JSONL + 全量重放**：本阶段规模（研究原型）足够； LSM/分段/归档未做，不虚报。
- 事件流为内存态：进程重启后历史事件不可取（截断语义已引导回退到回执）；不做事件持久化承诺。
- 崩溃注入点是 `afterClaim/afterStarted` 两处 + 真实 SIGKILL；未穷举所有崩溃点（如 fsync 中途——撕裂尾行用例已覆盖其后果）。

## 8. 结论

账本与对账达到 PR-HANDS-02B 验收口径：**先持久化后执行、终态先落盘再可观测、幂等键与 nonce 分离且各证其位、崩溃按副作用有无二分对账、UNKNOWN 保守不补跑、断连与取消互不僭越、事件有界有序**。全部证据来自真实文件字节、真实进程表、真实独立进程崩溃与恢复。状态 SELF-TESTED。
