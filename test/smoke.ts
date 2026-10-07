/* eslint-disable no-console */
// 纯 Node 冒烟测试：npx esbuild test/smoke.ts --bundle --format=esm --platform=node | node
import './shim';
import { store, publishResult, applyMeasurement, setWriteFailures, registerRetryable, removeOutbox } from '../src/store';
import { submitMeasurement, retryPending, submitConcurrentWeighing } from '../src/service';
import { computeRankings } from '../src/clearance';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const dispatch = store.dispatch.bind(store);
const getState = store.getState.bind(store);

// 初始：CHN 218 放行，106 待核（无当天称重），077 待核（证书过期+超限）
let s = getState().regatta;
const bySail = (sail: string) => s.clearance.find((r) => r.sailNo === sail)!;
check('初始 1 艘放行', s.clearance.filter((r) => r.status === 'cleared').length === 1);
check('CHN 218 已放行', bySail('CHN 218').status === 'cleared');
check('CHN 106 待核-缺当天称重', bySail('CHN 106').status === 'pending' && bySail('CHN 106').reasons.some((r) => r.includes('称重')));
check('CHN 077 待核-证书过期且超限', bySail('CHN 077').reasons.length === 2);
let rankings = computeRankings(s.clearance);
check('待核不占名次：只有 218 计入', rankings.length === 1 && rankings[0].sailNo === 'CHN 218');

// 发布正式成绩
dispatch(publishResult({}));
s = getState().regatta;
check('发布后有一版正式成绩', s.versions.length === 1 && s.versions[0].kind === 'official' && s.versions[0].status === 'current');

// 丈量员给 106 补当天称重（不超限）-> 旧名次作废，另存更正版
const r1 = await submitMeasurement(dispatch, getState, {
  draft: { kind: 'weighing', sailNo: 'CHN 106', crewWeightKg: 188, measuredAt: new Date().toISOString(), baseVersion: 0 },
  operatorId: 'o5', operatorName: '陆衡'
});
check('106 称重落地', r1.outcome === 'committed');
s = getState().regatta;
check('106 转放行', bySail('CHN 106').status === 'cleared');
check('旧版正式成绩作废', s.versions[0].status === 'superseded');
const current = s.versions.find((v) => v.status === 'current')!;
check('自动另存一版更正成绩', current.kind === 'correction' && current.serial === 2);
check('更正版含 2 艘名次', current.rankings.length === 2);
check('更正版名次顺序 218 第一', current.rankings[0].sailNo === 'CHN 218');

// 给 077 更新有效证书但重量仍超限 -> 仍待核
const r2 = await submitMeasurement(dispatch, getState, {
  draft: { kind: 'certificate', sailNo: 'CHN 077', certificateNo: 'MS-2026-0077', validFrom: new Date(Date.now() - 86400000).toISOString(), validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), measuredAt: new Date().toISOString(), baseVersion: 1 },
  operatorId: 'o4', operatorName: '沈测'
});
check('077 新证书落地', r2.outcome === 'committed');
s = getState().regatta;
check('077 证书通过但重量超限仍待核', bySail('CHN 077').certificateOk && !bySail('CHN 077').weightOk && bySail('CHN 077').status === 'pending');

// 两位丈量员同时称 218：先写入生效，后到冲突
const rr = await submitConcurrentWeighing(dispatch, getState, 'CHN 218', 191, 194, { id: 'o4', name: '沈测' }, { id: 'o5', name: '陆衡' });
check('并发称重一条 committed 一条 conflict', rr.some((x) => x.outcome === 'committed') && rr.some((x) => x.outcome === 'conflict'));
s = getState().regatta;
const conflict = s.conflicts[0];
check('冲突号生成', conflict.conflictNo.startsWith('CFT-'));
check('先写入者读数生效（191kg）', bySail('CHN 218').crewWeightKg === 191);
check('后到者看到当前读数 191', conflict.currentReading === 191 && (rr.find((x) => x.outcome === 'conflict') as any).currentReading === 191);
check('只多了一条称重记录版本', s.measurements.filter((m) => m.sailNo === 'CHN 218' && m.kind === 'weighing').length === 2);

// 后到者基于旧版本重试 -> 仍冲突，不覆盖
const staleBase = conflict.baseVersion;
const r3 = await submitMeasurement(dispatch, getState, {
  draft: { kind: 'weighing', sailNo: 'CHN 218', crewWeightKg: 194, measuredAt: new Date().toISOString(), baseVersion: staleBase },
  operatorId: 'o5', operatorName: '陆衡'
});
check('旧版本号重试仍冲突', r3.outcome === 'conflict');
check('读数未被覆盖', bySail('CHN 218').crewWeightKg === 191);

// 非丈量员越权：竞赛官 o1
const beforeCount = getState().regatta.measurements.length;
const r4 = await submitMeasurement(dispatch, getState, {
  draft: { kind: 'weighing', sailNo: 'CHN 218', crewWeightKg: 150, measuredAt: new Date().toISOString(), baseVersion: 2 },
  operatorId: 'o1', operatorName: '陈港'
});
check('越权登记被挡回', r4.outcome === 'denied');
s = getState().regatta;
check('挡回后无新丈量记录', s.measurements.length === beforeCount);
check('挡回留痕时间线', s.timeline.some((e) => e.type === 'system' && e.message.includes('越权')));
check('挡回不进发件盒', s.outbox.length === 0);

// 写入失败：登记留住，恢复后重试成功
dispatch(setWriteFailures(true));
const r5 = await submitMeasurement(dispatch, getState, {
  draft: { kind: 'weighing', sailNo: 'CHN 077', crewWeightKg: 197, measuredAt: new Date().toISOString(), baseVersion: 1 },
  operatorId: 'o4', operatorName: '沈测'
});
check('写入失败返回 failed', r5.outcome === 'failed');
s = getState().regatta;
check('失败登记留在发件盒', s.outbox.length === 1 && s.outbox[0].draft.crewWeightKg === 197);
check('失败期间无记录落地', s.measurements.filter((m) => m.sailNo === 'CHN 077' && m.kind === 'weighing').length === 1);
const tempId = s.outbox[0].tempId;
// 失败状态下重试仍留住
await retryPending(dispatch, getState, tempId);
s = getState().regatta;
check('故障中重试计数+1', s.outbox[0].attempts === 2);
dispatch(setWriteFailures(false));
const r6 = await retryPending(dispatch, getState, tempId);
check('恢复后重试落地', r6.outcome === 'committed');
s = getState().regatta;
check('落地后发件盒清空', s.outbox.length === 0);
check('077 重量合规后转放行', bySail('CHN 077').status === 'cleared');

// 直接调用 reducer 的越权保险（绕过 thunk）：applyMeasurement 对非丈量员目前不挡——服务层已挡；这里只保证数据流一致
void applyMeasurement; void registerRetryable; void removeOutbox;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
