# PR-HANDS-02A — 可信执行入口实施报告

> 状态：**SELF-TESTED**（自测试通过；不自行宣布独立 ACCEPT）
> 日期：2026-10-28
> 范围：将 Hands 从进程内库提升为独立用户态执行服务的**可信传输层**——资源 HMAC 鉴权、时间窗、nonce 防重放、服务端授权准入、内联权限拒绝、回环绑定策略、密钥治理与不泄漏不变量。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 知弈资源签名协议镜像 | **VERIFIED**（先读真实源码再写码；签名串逐字节一致） |
| 鉴权失败族（401/409/时间窗/篡改） | **VERIFIED**（真实服务实例 + 签名客户端对打） |
| 服务端授权准入（七类拒绝） | **VERIFIED**（准入口径全部来自服务端 store，客户端只交引用） |
| 内联授权/安全档位降级拒绝 | **VERIFIED** |
| 回环绑定拒绝 | **VERIFIED** |
| 密钥不泄漏（响应体/日志/账本三面扫描） | **VERIFIED** |
| 持久 nonce 存储（跨重启防重放） | **PROPOSED→有意未做**（当前为进程内 nonce 表；与知弈 local-runtime 同级。幂等键才是跨重启的耐久防线，且已有测试证明重启后重放不会二次执行——见 02B 报告） |
| 正式环境密钥分发/KMS | **BLOCKED**（本阶段离线；密钥经服务端 JSON 文件加载，轮换接口已备） |

新测试套件 `tests/service-auth.spec.ts`：**25/25 通过**（真实 PowerShell 进程、隔离工作区、隔离账本目录）。

---

## 1. 依据：先确认知弈真实实现，再写代码

PRD 要求"确认实际实现后再编写代码"。实现前通读两处权威源（kinlin_ai 本地只读副本）：

- `apps/agentOS/src/contracts/resource_signing.py`
  - `canonical_resource_request = "\n".join((method.upper(), path, str(timestamp), nonce, body_digest)).encode()`（body_digest 为 sha256 hex）
  - `build_resource_signature`：`key = sha256(secret).digest()`，HMAC-SHA256，hex 输出
- `apps/local-runtime/runtime/http_server.py`（`RuntimeRequestAuthenticator`）
  - 头：`X-Resource-Credential / X-Resource-Timestamp(unix 秒) / X-Resource-Nonce / X-Resource-Signature`
  - ±5 分钟时钟窗（`datetime` 差值比较）；nonce 字典 `expires_at = signed_at + skew`，先 purge 后查重；重放 → **409 REPLAY_REJECTED**
  - 比较为 `hmac.compare_digest`（定长定时间）
  - `Idempotency-Key` 头必须与信封字段一致；请求体上限 8MB；错误形 `{error:{code, retryable(status>=500), message}}`

## 2. Hands 侧实现（全部在自研 hands/ 层，vendored 代码零改动）

### 2.1 签名与鉴权 — `hands/auth.ts`

- `canonicalResourceRequest`（auth.ts:40）与 `buildResourceSignature`（auth.ts:46）：**逐字节复刻**上述构造（`METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`，key=sha256(secret)，HMAC-SHA256 hex）。
- `NonceStore`（auth.ts:66）：_seen 映射 + 到期清扫，镜像知弈进程内 nonce 字典。
- `ResourceAuthenticator.authenticate`（auth.ts:106）：
  1. 四头齐全否则 401；时间戳必须安全整数；
  2. `|now − ts| > skew` → 401（默认 skew=300_000ms，双向）；
  3. 凭据未知 → 401；
  4. 期望签名与来件签名 `timingSafeEqual`（先比长度再定长比较，等长 hex）；
  5. nonce 认领失败 → **409 REPLAY_REJECTED**。
- `HandsAuthError` 携带 code/status；错误体不含任何密钥材料。

### 2.2 凭据治理 — `hands/keys.ts`

- 多凭据并存（`credentialId → secret`）；`rotate()` 原子替换整套凭据（旧凭据即刻失效）；`fromParsedFile` 严格校验 `{credentials:[{credentialId,secret}]}` 形状。
- 秘密只存在于服务端文件与内存；任何 getter 不暴露明文集合。

### 2.3 服务端授权准入 — `hands/grant-store.ts`

- 授权**永远**由服务端 store 决定（构造时注入数组或 JSON 文件）；客户端信封只携带 `{grantId, workspaceId}` **引用**。
- `authorize()`（grant-store.ts:102）校验顺序：`GRANT_NOT_FOUND → CALLER_NOT_AUTHORIZED → WORKSPACE_MISMATCH → GRANT_REVOKED → GRANT_EXPIRED → GRANT_ROOT_MISMATCH → CAPABILITY_DENIED`。
- **调用方绑定**：`allowedCallers` ↔ 签名凭据 `credentialId`——只有持有秘密的签名者才可能成为 caller，客户端自报身份无效。
- **根绑定**：`canonicalRoot` 必须等于服务的工作区根（win32 大小写不敏感规范化）。
- **热加载**：grants 文件 mtime 变化即重载；撤销/过期在**下一次**准入生效（运行中的执行保持准入时授权——能力令牌语义，已写入文档注释）。
- 离线测试使用 `issueTestGrant` 测试签发方（服务侧），从不存在"客户端自签授权被信任"的路径。
- 准入通过后，服务把该授权**镜像**进引擎进程内注册表（`hands/grants.ts install()`，PR 新增）：引擎在 `execute()` 内的纵深复核使用服务端签发的 grantId，客户端无法注入。

### 2.4 服务管线 — `hands/service.ts`

`POST /v1/executions` 单入口管线：

```
原始 body → HMAC 鉴权（body 摘要绑定） → 信封校验（版本/能力集/内联权限拒绝）
→ Idempotency-Key 头==信封字段 → 服务端授权准入（caller=credentialId）
→ 账本认领（02B）→ 202 Accepted + 异步派发（与响应生命周期解耦）
```

- `GET /v1/health` 免鉴权，返回 `{ok, protocolVersion, service:'zhiyi-hands', uptimeMs, workspaceRoot}`。
- 传输无关内核 `handle()`（测试可直接驱动）；`node:http` 包装默认绑 `127.0.0.1`。
- **回环策略**：`start()` 先拒绝非回环 host（127.0.0.1/localhost/::1 之外直接抛错，fail-fast 在世界构建之前）。
- **请求体上限 8MB**（413）。
- 内联权限拒绝在两处纵深：信封校验（service 层 400 `HANDS_INLINE_AUTHORITY`）与引擎执行前复核（`protocol.ts rejectInlineAuthority`，键集含 `sandbox/sandboxPolicy/workspaceroot/allowedroots/writableroots/grantid/...`）——**安全档位只能由部署配置，客户端输入永不生效**。

### 2.5 CLI 入口 — `hands/service-main.ts`

`tsx hands/service-main.ts --config <json>`：独立进程运行服务（02B 崩溃测试依赖）；监听成功后输出一行 `READY {host,port}`；SIGINT/SIGTERM 优雅停机。配置字段见文件头注释；`faults` 仅为测试故障注入点。

## 3. 测试证据（tests/service-auth.spec.ts，25 用例）

| 类别 | 用例（摘） | 结果 |
|---|---|---|
| 健康/正路 | 免鉴权 health；正确签名 → 202 → 真实进程执行 → COMPLETED + 密封回执（含 `executedBy`） | ✓ |
| 鉴权失败 | 无头 401；错秘密 401；未知凭据 401；签名后改 body 401（摘要绑定）；签名后换 path 401（路径入签） | ✓ |
| 时间窗 | 过期时间戳（-400s）401；未来时间戳（+400s）401 | ✓ |
| nonce | 同 nonce 重放 → 409 REPLAY_REJECTED；**新 nonce 重试同幂等键** → 200 返回既有执行、副作用文件恰 1 次 tick | ✓ |
| 幂等键绑定 | 头与信封不一致 → 400 PROTOCOL_MISMATCH | ✓ |
| 准入七拒 | GRANT_NOT_FOUND / CALLER_NOT_AUTHORIZED（第二凭据对旁人 grant）/ WORKSPACE_MISMATCH / GRANT_REVOKED / GRANT_EXPIRED / GRANT_ROOT_MISMATCH / CAPABILITY_DENIED | ✓ |
| 协议 | protocolVersion 9 → 400 HANDS_PROTOCOL_UNSUPPORTED；未知 capabilityId → 400 | ✓ |
| 内联权限 | `input.workspaceroot` → 400；`input.sandbox='danger-full-access'` → 400；`input.sandboxPolicy={...}` → 400（全部 HANDS_INLINE_AUTHORITY） | ✓ |
| 传输策略 | host '0.0.0.0' 启动被拒 | ✓ |
| 秘密不泄漏 | 全量响应体 + 服务日志缓冲 + ledger.jsonl 字节 三面扫描两个真实秘密字符串，零命中 | ✓ |

测试客户端 `tests/service-client.ts` 用与知弈内核同构的签名器（直接复用 `buildResourceSignature`），含篡改钩子（签名后改头/换 body）。

## 4. 事故与修复记录（本 PR 内）

1. **service.ts 初版三处嫌疑**（自评发现，全部修复）：`Reflect.set(this,'#hands',...)` 字符串键无法触及真私有字段（该字段实为死代码，已删除）；ESM 中 `require('node:fs')`（改为顶部 import）；`GET /{id}/events` 路由被裸 `GET /{id}` 先匹配（重排序）。
2. **catch 变量遮蔽**：`catch (error)` 遮蔽模块级 `error()` 助手导致 TS2349（改名 `parseError`）。
3. **engine 工作区边界死循环（严重）**：本 PR 新增的 `assertWorkdirInsideWorkspace` 对不存在盘符（`Z:/...`）的祖先回溯 `while(!existsSync) probe=dirname(probe)` 在根处不终止——**同步死循环阻塞事件循环，连测试超时都无法触发**。回归中被 adversarial 套件卡死暴露；以 `dirname(probe)===probe` 终止条件修复，`D10 nonexistent workdir` 恢复 ENOENT 失败回执。教训已写入本报告与完整验收报告。

## 5. 边界与未做（不扩大承诺）

- nonce 表为进程内存级（与知弈 local-runtime 现实现同级）；跨进程重启后同 nonce 不会被拒——但幂等键防线已由 02B 崩溃套件证明（重启 + 同签名重放 → 返回既有记录，零二次执行）。
- 正式环境的密钥分发、轮换编排、审计外发为部署侧工作，本阶段不做、不虚报。
- 未引入 Agent Loop / LLM / Planner / ACG；vendored DSH 代码零修改；知弈主仓库零改动。

## 6. 结论

传输层达到 PR-HANDS-02A 验收口径：**签名协议与知弈实测实现一致、鉴权失败族完备、准入权威在服务端、内联权限与降级路径关闭、回环策略生效、秘密三面零泄漏**。全部断言基于真实系统效果（真实进程、真实文件、真实字节扫描）。状态 SELF-TESTED。
