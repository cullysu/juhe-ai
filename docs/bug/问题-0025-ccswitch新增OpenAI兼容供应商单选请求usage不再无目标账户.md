# BUG-0025 ccswitch 新增 OpenAI 兼容供应商单选请求 usage 不再无目标账户

## 基本信息

- 编号：BUG-0025
- 状态：已修复（新增回归）
- 严重程度：P1
- 发现时间：2026-06-25
- 发现方式：回归补充 / 人工排查
- 模块：后端 / 网关 / 使用记录 / OpenAI-compatible provider bootstrap
- 关联计划：无
- 关联 bug：无
- 责任人：待定

## 问题概述

- 现象：新增一个 OpenAI-compatible 供应商时，如果只给它保留一个可选账号并单独绑定到分组，`POST /v1/responses` 的网关请求在使用记录里不能再回退成 `无目标账户`。
- 期望：只要请求命中了真实账号，usage 记录必须同时保留真实 `accountId` 和真实 `accountName`，列表和详情都应显示真实账号名。
- 实际：现有回归只覆盖了“失败且没有 accountId 时显示 `无目标账户`”的边界，没有把“新 provider + 单账号选择 + OpenAI v1 请求 + usage 归属”串成一条端到端链路。
- 影响范围：任意新增的 OpenAI-compatible provider、单账号分组、OpenAI v1 `/v1/responses` 请求、使用记录展示。

## 复现步骤

1. 种一个 `ccswitch` 的 OpenAI-compatible provider，协议为 OpenAI v1，只有一个 `api_key` profile。
2. 用该 provider 创建一个只包含单账号的分组。
3. 发一条 `POST /v1/responses` 请求，`x-trace-id` 固定为 `trace_ccswitch_openai_v1_usage_account_regression`。
4. 查询使用记录，确认 `accountId` 等于真实账号 ID，`accountName` 等于真实账号名，不是 `无目标账户`。

## 本地 10088 严格验收

1. 先跑自动回归，作为主验收门槛：

```powershell
pnpm --filter juhe-ai-backend exec tsx src/scripts/regression/ccswitch-openai-v1-usage-account-regression.ts
```

2. 如果你要把同样场景放到本地 10088 入口复核，先把后端起到 `10088`，例如：

```powershell
$env:JUHE_AI_PORT = 10088
pnpm --filter juhe-ai-backend dev
```

然后重放同样的 `POST /v1/responses` 请求，`traceId` 固定，确认返回 200，使用记录里 `accountId/accountName` 正确。
3. 前端 selection 侧只复用既有覆盖：

```powershell
pnpm --filter juhe-ai-frontend test:generic-provider-selection
```

## 根因分析

- 现有 `usage-record-display-fallback` 只覆盖“没有 accountId 时，失败类记录显示无目标账户”的边界。
- 现有 `generic-provider-selection` 只覆盖前端纯逻辑，没有把“新 provider + 单选 + 真请求 + usage 归属”串成一条端到端链路。
- 这次新增的回归把 provider bootstrap、单账号选择、`/v1/responses` 请求和 usage 归属绑定到同一条 trace 上。

## 修复/回归策略

- 修改点：只新增后端回归脚本和 bug 文档，不动核心业务文件。
- 行为影响：无运行时行为变更，只补验收覆盖。
- 发版异常处理：若该脚本失败，优先看 `accountId` 是否为空、`accountName` 是否被回退成 `无目标账户`，以及请求是否实际打到了 `POST /v1/responses`。

## 验证记录

| 验证类型 | 内容 | 命令 / 步骤 | 预期结果 | 实际结果 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 回归验证 | 新增 OpenAI-compatible provider + 单账号 + `/v1/responses` + usage 归属 | `pnpm --filter juhe-ai-backend exec tsx src/scripts/regression/ccswitch-openai-v1-usage-account-regression.ts` | 通过 | 通过 | 已通过 |
| 相关既有覆盖 | frontend 纯 selection 逻辑 | `pnpm --filter juhe-ai-frontend test:generic-provider-selection` | 通过 | 通过 | 已通过 |
| 类型检查 | 后端类型检查 | `pnpm --filter juhe-ai-backend typecheck` | 通过 | 通过 | 已通过 |

## 下次遇到

- 先查 `usage_records` 里的 `account_id/account_name`，不要先盯 `无目标账户` 文案。
- 先确认请求真的命中了新 provider 的单个账号，再确认 usage 写入。
- 这类问题不要只看 UI 文案，要同时看 `traceId`、请求路径和落库字段。

## 完成总结

- 完成时间：2026-06-25
- 结论：新增 regression script 把 ccswitch / OpenAI v1 / 单账号选择 / usage 归属串成一条端到端链路。
- 后续建议：新增 OpenAI-compatible provider 时，至少保留一条“单账号请求后 usage 归属”的回归。
