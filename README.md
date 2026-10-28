# ZhiYi Hands-P0 — 隔离验证样机

知弈（ZhiYi AgentOS）独立执行引擎 P0 预研样机。基于 DeepSeek Harness（DSH，MIT）执行基座的逐字提取，通过自有的 Execution World 边界与版本化协议对外暴露。**预研工作区——不属于知弈主线，未做生产可用自评。**

## 来源与合规

- Vendor 子集：`vendor/` 内全部 `.ts` 文件**逐字复制**自 `deepseek-ai/deepseek-harness @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（MIT，许可证副本在 `vendor/LICENSE`）。唯一布局调整：各包恢复 `src/` 层级（与上游嵌套一致，使 `import.meta.url` 相对路径语义不变）。
- 自研代码：`hands/`（协议、授权、Provider 边界、引擎、CLI）、`tests/`。
- 外部依赖闭包：`koffi@3.1.1`（Win32 FFI，MIT）、`chokidar@5.0.0`（MIT）、`undici@8.11.2`（MIT，http-proxy 工具包引用）、`tsx`/`vitest`/`typescript`（开发工具链）。`node-pty` 仅作类型引用且安装脚本被 pnpm 策略拒绝，运行时永不加载。

## 布局

```
hands/
  protocol.ts        版本化协议合同（对齐知弈 LocalRuntimeExecutionRequest 族）
  grants.ts          Grant 签发/校验（对齐知弈 grants 语义与错误码族）
  providers.ts       Execution World 边界：Filesystem/Process/Resource Provider 接口
  shell-policy.ts    Shell 可执行策略：钉原生/拒绝 MSIX 别名/身份摘要（PR-HANDS-01）
  world.ts           DSH World 适配器（唯一知道 cordis/@deepseek-ai/* 的文件）
                     JobGuardedSubprocessRuntime：Job 不可用即 fail-closed，无静默回退
                     confinement:'acl'：Windows 受限令牌沙箱装配（PR-HANDS-01）
  native-fallback.ts 自研第二 ProcessProvider（证明 Provider 可换性）
  engine.ts          引擎：校验→授权→限流→分发→收据封章（收据含 executedBy 身份）
  index.ts / cli.ts  组装入口与无 LLM 演示
vendor/              DSH 逐字提取子集（87 文件，PROVENANCE.json 记录与上游逐字一致）
                     + 最小类型 stub（session/sandbox-policy/dsh-skill）
tests/p0.spec.ts           P0 六项目标 16 项验收（回归基线）
tests/shell-policy.spec.ts Shell 策略 11 项（真实 MSIX 别名拒绝/身份入收据/装配守卫）
tests/adversarial.spec.ts  对抗 11 项（junction/8.3/Job 崩溃/守卫 fail-closed/spill/过期/收据完整性）
tests/sandbox-acl.spec.ts  Windows ACL 沙箱 8 项（真实 OS 级拒绝/junction/temp 语义/残留回撤/树清理）
evidence/            运行日志、失败证据（tree-kill-store-pwsh-escape.md 等）
```

## 两条明确分离的执行路径（PR-HANDS-01）

- `confinement: 'none'`（默认）— fs 写围栏 + 未受限 shell（P0 语义不变）
- `confinement: 'acl'` — 上述之外，shell 经 Windows WRITE_RESTRICTED 受限令牌运行：
  工作区外写入被 **操作系统** 拒绝（非应用层）；受限令牌下子进程创建本身被 OS 拒绝
  （多进程命令在此模式不可用 — 见 PR-HANDS-01 报告的实测记录）

## 运行

```bash
pnpm install        # node-pty 构建脚本被 pnpm 策略拒绝是预期行为
pnpm typecheck      # hands + tests + vendor 全量，DSH 上游等价严格度
pnpm test           # 16 项 P0 验收（真实 PowerShell/Job Object/ACL fence）
pnpm demo           # 无 LLM 全流程演示（含 Provider 换装）
```

## 测试（46/46 通过）

P0 六项目标映射（16 项）+ Shell 策略（11）+ 对抗（11）+ ACL 沙箱（8）。
ACL 测试在专用可恢复环境 `.acl-test-env/`（项目内、自动清理）运行，绝不触碰真实工作区安全描述符。

## P0 六项目标 → 测试映射（16/16 通过）

1. 无 LLM 文件读写 → `writes and reads a file with NO LLM...`
2. PowerShell 完整采集 → `captures stdout, stderr and the exit code...`
3. 超时/取消/进程树 → timeout / cancellation / tree-kill / background-handle 四项
4. 拒绝工作区外写入 → `DENIES writes outside the workspace...` + read-only 模式
5. 执行身份与结果收据 → checksum 可重算、identity 回显、六种授权错误码
6. Provider 可换 → SandboxedFS↔LocalFS、pwsh↔bash、DSH shell↔native fallback

## 已知限制

- Store 版 pwsh 的孙进程会逃逸 Job（原生 5.1 正常）——见 `evidence/tree-kill-store-pwsh-escape.md`；P1 应在装配层强制原生可执行。
- 写入围栏是可信代码内的策略检查（DSH `SandboxedFileSystem` 语义），不是内核边界；残余 TOCTOU 为 DSH 已接受威胁模型。
- DSH `writableRoots` 设计上总是允许 OS 临时目录写入（命令临时空间）——围栏测试的逃逸探针因此使用临时目录之外的路径。
