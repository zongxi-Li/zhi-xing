# 失败证据：Store 版 pwsh 的孙进程逃逸 Windows Job

**日期**: 2026-10-27 ｜ **环境**: Windows 11 (26100) x64, Node 24.19.0, hands-p0 @ commit-less 预研工作区
**标记**: VERIFIED（诊断脚本可复现，见 `evidence/diag-tree3.mts`，运行 `node --import tsx/esm evidence/diag-tree3.mts <store|ps51>`）

## 现象

通过 DSH 执行链（PwshLocalExecutor → LocalSubprocessRuntime → Windows Job runner）运行：

```powershell
Start-Process -FilePath "ping.exe" -ArgumentList "-n","300","127.0.0.1" -PassThru ...
Start-Sleep -Seconds 120
```

在超时/取消触发整树终止后：

| 变体 | shell 可执行 | 结果 |
|---|---|---|
| store | `C:\Users\LZX\AppData\Local\Microsoft\WindowsApps\pwsh.exe`（MSIX 别名） | **孙进程 ping.exe 在 kill 后 5s+ 仍然存活**（脱离 Job） |
| ps51 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（原生） | 孙进程随 shell 一起被杀（Job 语义正确） |

对照组运行记录（`grandchild pid` 各次不同，属正常）：

```
[store] grandchild pid: 9184 / 30860
[store] grandchild after kill: ALIVE (ESCAPED THE JOB)
[ps51]  grandchild pid: 18740
[ps51]  grandchild after kill: dead (tree killed)
```

## 已排除的原因

- `probeWindowsJob()` 返回 true（`evidence/diag-mode.mts`）：Job 路径确实被选中，未走 taskkill fallback。
- shell 自身被正确终止（exitCode 1 = TerminateJobObject 终止码），说明 IPC terminate → `TerminateJobObject` 链路工作正常。
- 非 MSIX 原生 pwsh/powershell 下同一机制完全正确 → DSH 代码无缺陷。

## 判定根因（高置信，未做内核级证实）

Microsoft Store 安装的 `pwsh.exe` 是 **MSIX AppExecutionAlias**（reparse point）。由打包应用派生的进程受包语义/独立 Job 约束，孙进程未能保持在我们 kill-on-close Job 的继承集合内。

## 对 Hands 的影响与缓解

1. **P0 已采取**：tree-kill 验收测试固定 `shellExecutablePath` 为原生 5.1（`tests/p0.spec.ts`）。
2. **接口已预留**：`createDshWorld({ shellExecutablePath })`（`hands/world.ts`）可显式钉住原生可执行。
3. **P1 建议**：Hands 装配层默认拒绝 MSIX 别名路径（`WindowsApps` 目录探测），或强制优先 System32/Program Files 原生安装；在收据 `output.sandbox` 中回传实际使用的可执行路径，供对账。
4. **约束遵守**：本轮不对该机制做任何安全保证声明；该发现作为"存在冲突的机制，需要重新验证的安全假设"记录（PRD 任务 C）。
