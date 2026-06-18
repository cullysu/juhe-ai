import { strict as assert } from 'node:assert'

import { usageRecordSummaryFromRow, type UsageRecordRow } from '../../storage/usage-record-mappers.js'

const baseRow: UsageRecordRow = {
  id: 'usage_display_fallback_regression',
  trace_id: 'trace_usage_display_fallback_regression',
  traffic_source: 'gateway',
  stream: 0,
  success: 0,
  created_at: '2026-06-18T00:00:00.000Z'
}

const failedNoAccount = summary(baseRow)
assert.equal(failedNoAccount.accountName, '网关未选中账号', '网关失败且未选中上游账号时应返回明确账号文案')

const manualFailedNoAccount = summary({ ...baseRow, traffic_source: 'manual_account_test' })
assert.equal(manualFailedNoAccount.accountName, '网关未选中账号', '手动测试失败且未选中上游账号时应返回明确账号文案')

const cooldownFailedNoAccount = summary({ ...baseRow, traffic_source: 'cooldown_retest' })
assert.equal(cooldownFailedNoAccount.accountName, '网关未选中账号', '恢复探活失败且未选中上游账号时应返回明确账号文案')

const deletedAccount = summary({ ...baseRow, account_id: 'account_deleted_or_unknown' })
assert.equal(deletedAccount.accountName, undefined, '有账号 ID 但名称缺失时应保留已删除或未知语义')

const successfulNoAccount = summary({ ...baseRow, success: 1 })
assert.equal(successfulNoAccount.accountName, undefined, '成功记录没有账号时不应伪造失败文案')

const namedAccount = summary({ ...baseRow, account_id: 'account_display_named', account_name: '真实上游账号' })
assert.equal(namedAccount.accountName, '真实上游账号', '已有账号名称时应优先返回真实名称')

console.log('使用记录账号显示回归通过：无选中上游账号的失败记录会显示网关未选中账号')

function summary(row: UsageRecordRow) {
  return usageRecordSummaryFromRow(row, false, new Map())
}
