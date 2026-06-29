import type { UsageRecordSummary } from '@/types/domain'
import { accountDisplayText, errorText } from '../../views/usage-records/usageRecordFormatters'

const failedNoAccount = usageRecord({ success: false })
assertEqual(accountDisplayText(failedNoAccount), '无目标账户', '失败记录未选中上游账号时应显示无目标账户')
assertEqual(errorText(failedNoAccount), '无目标账户', '失败记录未选中上游账号时错误提示也应显示无目标账户')

assertEqual(
  accountDisplayText(usageRecord({ success: false, trafficSource: 'manual_account_test' })),
  '-',
  '手动测试记录缺失账号时不应显示无目标账户'
)
assertEqual(
  accountDisplayText(usageRecord({ success: false, trafficSource: 'cooldown_retest' })),
  '-',
  '恢复探活记录缺失账号时不应显示无目标账户'
)
assertEqual(
  errorText(usageRecord({ success: false, trafficSource: 'cooldown_retest' })),
  '-',
  '恢复探活错误提示缺失账号时不应显示无目标账户'
)

assertEqual(
  accountDisplayText(usageRecord({ success: false, accountId: 'account_deleted_or_unknown' })),
  '已删除或未知',
  '有账号 ID 但名称缺失时应保留已删除或未知语义'
)
assertEqual(
  accountDisplayText(usageRecord({ success: true })),
  '-',
  '成功记录没有账号时应显示空值占位'
)
assertEqual(
  accountDisplayText(usageRecord({ success: false, accountId: 'account_named', accountName: '真实上游账号' })),
  '真实上游账号',
  '已有账号名称时应优先显示真实账号名称'
)

console.log('使用记录 formatter 回归通过：无选中上游账号的失败记录显示无目标账户')

function usageRecord(overrides: Partial<UsageRecordSummary> = {}): UsageRecordSummary {
  return {
    id: 'usage_record_formatter_regression',
    traceId: 'trace_usage_record_formatter_regression',
    trafficSource: 'gateway',
    stream: false,
    success: true,
    createdAt: '2026-06-18T00:00:00.000Z',
    ...overrides
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}，期望 ${String(expected)}，实际 ${String(actual)}`)
  }
}
