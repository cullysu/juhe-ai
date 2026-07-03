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
assert.equal(failedNoAccount.accountName, '无目标账户', '网关失败且未选中上游账号时应返回明确账号文案')

const requestTooLargePreflight = summary({ ...baseRow, status_code: 413, error_code: 'request_too_large' })
assert.equal(requestTooLargePreflight.accountName, '网关预检拒绝', '请求体过大在账号调度前被拒绝时不应显示为无目标账户')

const bodyOmissionPreflight = summary({
  ...baseRow,
  error_code: 'server_overloaded',
  request_snapshot_json: JSON.stringify({
    bodyOmission: {
      reason: 'gateway_body_metadata_worker'
    }
  })
})
assert.equal(bodyOmissionPreflight.accountName, '网关预检拒绝', '网关 body 预检拒绝应显示为预检拒绝而不是无目标账户')

const manualFailedNoAccount = summary({ ...baseRow, traffic_source: 'manual_account_test' })
assert.equal(manualFailedNoAccount.accountName, undefined, '手动测试失败记录不应把缺失账号伪装成无目标账户')

const cooldownFailedNoAccount = summary({ ...baseRow, traffic_source: 'cooldown_retest' })
assert.equal(cooldownFailedNoAccount.accountName, undefined, '恢复探活记录不应把缺失账号伪装成无目标账户')

const deletedAccount = summary({ ...baseRow, account_id: 'account_deleted_or_unknown' })
assert.equal(deletedAccount.accountName, undefined, '有账号 ID 但名称缺失时应保留已删除或未知语义')

const successfulNoAccount = summary({ ...baseRow, success: 1 })
assert.equal(successfulNoAccount.accountName, undefined, '成功记录没有账号时不应伪造失败文案')

const namedAccount = summary({ ...baseRow, account_id: 'account_display_named', account_name: '真实上游账号' })
assert.equal(namedAccount.accountName, '真实上游账号', '已有账号名称时应优先返回真实名称')

console.log('使用记录账号显示回归通过：无选中上游账号和网关预检拒绝会显示不同账号文案')

function summary(row: UsageRecordRow) {
  return usageRecordSummaryFromRow(row, false, new Map())
}
