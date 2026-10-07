import type { MeasurementDraft, MeasurementRecord } from './types';
import { currentVersion } from './clearance';
import { isMeasurer } from './officials';
import {
  applyMeasurement,
  denyMeasurement,
  recordConflict,
  registerRetryable,
  type AppDispatch,
  type RootState
} from './store';

export interface SubmitParams {
  tempId?: string;
  draft: MeasurementDraft;
  operatorId: string;
  operatorName: string;
}

export type SubmitOutcome =
  | { outcome: 'committed'; recordId: string }
  | { outcome: 'conflict'; conflictNo: string; currentReading: number; winnerMeasurerName: string }
  | { outcome: 'denied' }
  | { outcome: 'failed'; tempId: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 丈量员提交一条登记：先写入者生效；后到的称重提交看到当前读数并拿到冲突号 */
export async function submitMeasurement(dispatch: AppDispatch, getState: () => RootState, params: SubmitParams): Promise<SubmitOutcome> {
  const { draft, operatorId, operatorName } = params;
  const tempId = params.tempId ?? crypto.randomUUID();

  // 非丈量员越权登记，挡回去（不进发件盒、不产生记录）
  if (!isMeasurer(operatorId)) {
    dispatch(denyMeasurement({ measurerName: operatorName, kind: draft.kind, sailNo: draft.sailNo }));
    return { outcome: 'denied' };
  }

  // 模拟写入失败：留住没落地的登记，之后可重试
  if (getState().regatta.writeFailures) {
    dispatch(registerRetryable({ tempId, draft, measurerId: operatorId, measurerName: operatorName, lastError: '写入通道故障，登记暂存待重试' }));
    return { outcome: 'failed', tempId };
  }

  const records = getState().regatta.measurements;

  // 同船称重并发：以开单版本号对比，先写入者已把版本抬高，后到者冲突
  if (draft.kind === 'weighing' && draft.baseVersion !== currentVersion(records, draft.sailNo, 'weighing')) {
    const current = records
      .filter((r) => r.sailNo === draft.sailNo && r.kind === 'weighing')
      .sort((a, b) => b.version - a.version)[0] as MeasurementRecord | undefined;
    const conflicts = getState().regatta.conflicts;
    const conflictNo = `CFT-${String(conflicts.length + 1).padStart(3, '0')}`;
    dispatch(recordConflict({
      conflictNo,
      tempId,
      sailNo: draft.sailNo,
      rejectedWeightKg: draft.crewWeightKg ?? 0,
      loserMeasurerId: operatorId,
      loserMeasurerName: operatorName,
      winnerMeasurerName: current?.measurerName ?? '未知',
      baseVersion: draft.baseVersion,
      currentRecordId: current?.id ?? '',
      currentReading: current?.crewWeightKg ?? 0,
      currentMeasuredAt: current?.measuredAt ?? new Date().toISOString()
    }));
    return {
      outcome: 'conflict',
      conflictNo,
      currentReading: current?.crewWeightKg ?? 0,
      winnerMeasurerName: current?.measurerName ?? '未知'
    };
  }

  const recordId = crypto.randomUUID();
  dispatch(applyMeasurement({ recordId, tempId, draft, measurerId: operatorId, measurerName: operatorName }));
  return { outcome: 'committed', recordId };
}

/** 两位丈量员同时提交同一艘船的称重：用于演示先写入生效、后到拿到冲突号 */
export async function submitConcurrentWeighing(
  dispatch: AppDispatch,
  getState: () => RootState,
  sailNo: string,
  weightA: number,
  weightB: number,
  operatorA: { id: string; name: string },
  operatorB: { id: string; name: string }
): Promise<SubmitOutcome[]> {
  const baseVersion = currentVersion(getState().regatta.measurements, sailNo, 'weighing');
  const measuredAt = new Date().toISOString();
  const makeDraft = (weight: number): MeasurementDraft => ({
    kind: 'weighing', sailNo, crewWeightKg: weight, measuredAt, baseVersion
  });
  // 两张单子基于同一个读数同时开出，提交有先后但版本号相同
  await wait(10);
  const first = submitMeasurement(dispatch, getState, { draft: makeDraft(weightA), operatorId: operatorA.id, operatorName: operatorA.name });
  await wait(10);
  const second = submitMeasurement(dispatch, getState, { draft: makeDraft(weightB), operatorId: operatorB.id, operatorName: operatorB.name });
  return Promise.all([first, second]);
}

/** 重试一条没落地的登记 */
export async function retryPending(dispatch: AppDispatch, getState: () => RootState, tempId: string): Promise<SubmitOutcome | { outcome: 'missing' }> {
  const pending = getState().regatta.outbox.find((w) => w.tempId === tempId);
  if (!pending) return { outcome: 'missing' };
  if (getState().regatta.writeFailures) {
    dispatch(registerRetryable({ tempId, draft: pending.draft, measurerId: pending.measurerId, measurerName: pending.measurerName, lastError: '写入通道仍故障' }));
    return { outcome: 'failed', tempId };
  }
  return submitMeasurement(dispatch, getState, { tempId, draft: pending.draft, operatorId: pending.measurerId, operatorName: pending.measurerName });
}

/** 重试发件盒里全部没落地的登记 */
export async function retryAllPending(dispatch: AppDispatch, getState: () => RootState): Promise<{ committed: number; failed: number; conflict: number }> {
  const tempIds = [...getState().regatta.outbox].map((w) => w.tempId);
  const result = { committed: 0, failed: 0, conflict: 0 };
  for (const tempId of tempIds) {
    const r = await retryPending(dispatch, getState, tempId);
    if (r.outcome === 'committed') result.committed += 1;
    else if (r.outcome === 'conflict') result.conflict += 1;
    else if (r.outcome === 'failed') result.failed += 1;
  }
  return result;
}
