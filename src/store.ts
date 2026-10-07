import { configureStore, createSlice, type PayloadAction, type WritableDraft } from '@reduxjs/toolkit';
import type {
  ClearanceStatus,
  MeasurementConflict,
  MeasurementDraft,
  MeasurementRecord,
  PendingWrite,
  Protest,
  ProtestStatus,
  Race,
  RaceEntry,
  ResultVersion,
  TimelineEvent
} from './types';
import { raceApi } from './api';
import { buildClearance, computeRankings, nextVersion, pendingSailNos, rankingsEqual } from './clearance';
import { backfillClearance } from './migration';

export interface AppState {
  schemaVersion: 2;
  races: Race[];
  entries: RaceEntry[];
  /** 丈量记录（证书登记 + 船员称重） */
  measurements: MeasurementRecord[];
  /** 后到的称重提交拿到的冲突凭据 */
  conflicts: MeasurementConflict[];
  /** 参赛条目 × 丈量 × 成绩的放行依据快照 */
  clearance: ReturnType<typeof buildClearance>;
  /** 已发布成绩版次，旧版作废后原样留档 */
  versions: ResultVersion[];
  protests: Protest[];
  timeline: TimelineEvent[];
  /** 没落地的登记，留住后重试 */
  outbox: PendingWrite[];
  /** 写入开关：true 时模拟写入失败 */
  writeFailures: boolean;
}

type RaceStatus = Race['status'];
type DraftState = WritableDraft<AppState>;

const now = new Date();
const isoDays = (offsetDays: number, endOfDay = false) => {
  const d = new Date(now.getTime() + offsetDays * 86400000);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.toISOString();
};
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
export const DEFAULT_WEIGHT_LIMIT = 200;

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'provisional', note: '' }
];

const initialMeasurements: MeasurementRecord[] = [
  {
    id: 'meas-1', kind: 'certificate', sailNo: 'CHN 218', certificateNo: 'MS-2026-0218',
    validFrom: isoDays(-30), validUntil: isoDays(30, true), measuredAt: isoDays(-2),
    measurerId: 'o4', measurerName: '沈测', version: 1
  },
  {
    id: 'meas-2', kind: 'weighing', sailNo: 'CHN 218', crewWeightKg: 198, measuredAt: now.toISOString(),
    measurerId: 'o4', measurerName: '沈测', version: 1
  },
  {
    id: 'meas-3', kind: 'certificate', sailNo: 'CHN 106', certificateNo: 'MS-2026-0106',
    validFrom: isoDays(-30), validUntil: isoDays(30, true), measuredAt: isoDays(-1),
    measurerId: 'o5', measurerName: '陆衡', version: 1
  },
  {
    // 北辰号：证书昨天过期，且当天称重超限
    id: 'meas-4', kind: 'certificate', sailNo: 'CHN 077', certificateNo: 'MS-2025-0077',
    validFrom: isoDays(-365), validUntil: isoDays(-1, true), measuredAt: isoDays(-40),
    measurerId: 'o4', measurerName: '沈测', version: 1
  },
  {
    id: 'meas-5', kind: 'weighing', sailNo: 'CHN 077', crewWeightKg: 205, measuredAt: now.toISOString(),
    measurerId: 'o5', measurerName: '陆衡', version: 1
  }
];

const initialRace: Race = {
  id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节',
  startsAt: initialStart, status: 'scheduled', weightLimitKg: DEFAULT_WEIGHT_LIMIT
};

function buildInitialState(): AppState {
  const evaluatedAt = now.toISOString();
  return {
    schemaVersion: 2,
    races: [initialRace],
    entries: initialEntries,
    measurements: initialMeasurements,
    conflicts: [],
    clearance: buildClearance(initialRace, initialEntries, initialMeasurements, evaluatedAt),
    versions: [],
    protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
    timeline: [
      { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
      { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' },
      { id: 'event-3', time: new Date(now.getTime() + 3000).toISOString(), type: 'measurement', message: '放行依据已建立：1 艘已放行，2 艘待核（远岚号缺当天称重，北辰号证书过期且重量超限）' }
    ],
    outbox: [],
    writeFailures: false
  };
}

function pushTimeline(state: DraftState, type: TimelineEvent['type'], message: string, timeIso = new Date().toISOString()) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: timeIso, type, message });
}

function statusLabel(status: ClearanceStatus): string {
  return status === 'cleared' ? '已放行' : '待核';
}

/** 重算放行依据；若已有发布版次且名次/待核集合变化，旧版作废并另存更正版 */
function recomputeClearance(state: DraftState, changeReason: string | null) {
  const race = state.races[0];
  const evaluatedAt = new Date().toISOString();
  const backfilledIds = state.clearance.filter((r) => r.backfilled).map((r) => r.entryId);
  state.clearance = buildClearance(race, state.entries, state.measurements, evaluatedAt, backfilledIds);
  const rankings = computeRankings(state.clearance);
  const pending = pendingSailNos(state.clearance);
  const current = state.versions.find((v) => v.status === 'current');
  if (!current || !changeReason) return;

  const pendingChanged =
    current.pendingSailNos.length !== pending.length ||
    [...current.pendingSailNos].sort().join(',') !== [...pending].sort().join(',');
  if (rankingsEqual(current.rankings, rankings) && !pendingChanged) return;

  current.status = 'superseded';
  current.supersededAt = evaluatedAt;
  const serial = state.versions.reduce((max, v) => Math.max(max, v.serial), 0) + 1;
  state.versions.push({
    id: crypto.randomUUID(),
    raceId: race.id,
    serial,
    kind: 'correction',
    status: 'current',
    publishedAt: evaluatedAt,
    reason: changeReason,
    rankings,
    pendingSailNos: pending
  });
  state.entries.forEach((entry) => {
    if (entry.resultStatus === 'official') entry.resultStatus = 'corrected';
  });
  pushTimeline(state, 'result', `第 ${current.serial} 版成绩已作废重算，另存第 ${serial} 版更正成绩（${changeReason}）`);
}

const slice = createSlice({
  name: 'regatta',
  initialState: buildInitialState(),
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: RaceStatus }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (!race) return;
      race.status = action.payload.status;
      pushTimeline(state, 'race', `${race.name} 状态更新为 ${race.status}`);
      if (action.payload.status === 'running') {
        // 开赛瞬间按比赛时点固化一版放行核对
        recomputeClearance(state, null);
        const cleared = state.clearance.filter((r) => r.status === 'cleared').length;
        const pending = state.clearance.filter((r) => r.status === 'pending');
        pushTimeline(state, 'measurement', `开赛前放行核对：${cleared} 艘放行、${pending.length} 艘待核${pending.length ? `（${pending.map((r) => r.sailNo).join('、')} 不占正式名次）` : ''}`);
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      if (changed) entry.resultStatus = entry.resultStatus === 'official' ? 'corrected' : 'provisional';
      pushTimeline(state, 'result', `${entry.boat} 净用时更新为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒`);
      if (changed) recomputeClearance(state, `${entry.boat} 净用时更新触发重算`);
    },
    publishResult(state, action: PayloadAction<{ reason?: string }>) {
      const race = state.races[0];
      const evaluatedAt = new Date().toISOString();
      recomputeClearance(state, null);
      const rankings = computeRankings(state.clearance);
      const pending = pendingSailNos(state.clearance);
      const current = state.versions.find((v) => v.status === 'current');
      if (current) {
        current.status = 'superseded';
        current.supersededAt = evaluatedAt;
      }
      const serial = state.versions.reduce((max, v) => Math.max(max, v.serial), 0) + 1;
      state.versions.push({
        id: crypto.randomUUID(),
        raceId: race.id,
        serial,
        kind: 'official',
        status: 'current',
        publishedAt: evaluatedAt,
        reason: action.payload.reason ?? '按放行依据发布正式成绩',
        rankings,
        pendingSailNos: pending
      });
      const clearedIds = new Set(state.clearance.filter((r) => r.status === 'cleared').map((r) => r.entryId));
      state.entries.forEach((entry) => {
        if (clearedIds.has(entry.id)) entry.resultStatus = 'official';
      });
      pushTimeline(state, 'result', `第 ${serial} 版正式成绩已发布（${rankings.length} 艘计入名次，${pending.length} 艘待核不占位）`);
    },
    /** 越权登记：非丈量员挡回去，只留时间线，不产生任何记录 */
    denyMeasurement(state, action: PayloadAction<{ measurerName: string; kind: MeasurementDraft['kind']; sailNo: string }>) {
      const kindLabel = action.payload.kind === 'weighing' ? '称重' : '证书';
      pushTimeline(state, 'system', `越权登记已挡回：${action.payload.measurerName}（非丈量员）试图登记 ${action.payload.sailNo} 的${kindLabel}`);
    },
    /** 写入失败：没落地的登记进发件盒，留住等待重试 */
    registerRetryable(state, action: PayloadAction<Omit<PendingWrite, 'attempts' | 'createdAt'> & { attempts?: number }>) {
      const item = action.payload;
      const existing = state.outbox.find((w) => w.tempId === item.tempId);
      if (existing) {
        existing.attempts += 1;
        existing.lastError = item.lastError;
      } else {
        state.outbox.push({
          tempId: item.tempId,
          draft: item.draft,
          measurerId: item.measurerId,
          measurerName: item.measurerName,
          attempts: item.attempts ?? 1,
          lastError: item.lastError,
          createdAt: new Date().toISOString()
        });
      }
    },
    removeOutbox(state, action: PayloadAction<{ tempId: string }>) {
      state.outbox = state.outbox.filter((w) => w.tempId !== action.payload.tempId);
    },
    /** 后到的称重提交被挡回：登记冲突号与当前读数（不写入） */
    recordConflict(state, action: PayloadAction<Omit<MeasurementConflict, 'rejectedAt'>>) {
      state.conflicts.unshift({ ...action.payload, rejectedAt: new Date().toISOString() });
      const c = action.payload;
      pushTimeline(state, 'measurement', `称重冲突 ${c.conflictNo}：${c.loserMeasurerName} 提交 ${c.sailNo} ${c.rejectedWeightKg}kg 未生效，当前读数 ${c.currentReading}kg（${c.winnerMeasurerName}）`);
    },
    /** 丈量登记落地：先写入者的版本生效，随后重核放行、必要时作废旧名次 */
    applyMeasurement(state, action: PayloadAction<{ recordId: string; tempId: string; draft: MeasurementDraft; measurerId: string; measurerName: string }>) {
      const { recordId, tempId, draft, measurerId, measurerName } = action.payload;
      state.measurements.push({
        id: recordId,
        tempId,
        kind: draft.kind,
        sailNo: draft.sailNo,
        certificateNo: draft.certificateNo,
        validFrom: draft.validFrom,
        validUntil: draft.validUntil,
        crewWeightKg: draft.crewWeightKg,
        measuredAt: draft.measuredAt,
        measurerId,
        measurerName,
        version: nextVersion(state.measurements, draft.sailNo, draft.kind)
      });
      state.outbox = state.outbox.filter((w) => w.tempId !== tempId);

      const reason = draft.kind === 'weighing'
        ? `${draft.sailNo} 称重更新为 ${draft.crewWeightKg}kg（${measurerName}）`
        : `${draft.sailNo} 证书更新为 ${draft.certificateNo}（${measurerName}）`;
      pushTimeline(state, 'measurement', `丈量登记已落地：${reason}，放行依据重核`);

      const before = state.clearance.find((r) => r.sailNo === draft.sailNo);
      recomputeClearance(state, reason);
      const after = state.clearance.find((r) => r.sailNo === draft.sailNo);
      if (before && after && before.status !== after.status) {
        pushTimeline(state, 'measurement', `${draft.sailNo} 放行状态 ${statusLabel(before.status)} → ${statusLabel(after.status)}${after.status === 'pending' ? `：${after.reasons.join('；')}` : ''}`);
      }
    },
    setWriteFailures(state, action: PayloadAction<boolean>) {
      state.writeFailures = action.payload;
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      pushTimeline(state, 'protest', `收到 ${action.payload.rule} 抗议，等待复核`, protest.createdAt);
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds) {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.resultStatus = 'corrected';
          recomputeClearance(state, `${entry.boat} 抗议判罚 ${action.payload.penaltySeconds} 秒，名次重算`);
        }
      }
      pushTimeline(state, 'protest', `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}`);
    }
  }
});

/** v1 旧数据没有检验快照：升级时按比赛当天最近记录补档，补不到的留在待核 */
function migrateV1(raw: Record<string, unknown>): AppState {
  const migratedAt = new Date().toISOString();
  const oldRaces = (raw.races ?? []) as Race[];
  const oldEntries = (raw.entries ?? []) as RaceEntry[];
  const race: Race = { ...oldRaces[0], weightLimitKg: DEFAULT_WEIGHT_LIMIT };
  const legacyRecords: MeasurementRecord[] = Array.isArray(raw.measurements) ? (raw.measurements as MeasurementRecord[]) : [];
  const clearance = backfillClearance(race, oldEntries, legacyRecords, migratedAt);
  const pendingCount = clearance.filter((r) => r.status === 'pending').length;

  return {
    schemaVersion: 2,
    races: [race],
    entries: oldEntries,
    measurements: legacyRecords,
    conflicts: [],
    clearance,
    versions: [],
    protests: (raw.protests ?? []) as Protest[],
    timeline: [
      { id: crypto.randomUUID(), time: migratedAt, type: 'system', message: `旧版数据升级：已按比赛当天最近记录补档放行快照，${clearance.length - pendingCount} 艘放行、${pendingCount} 艘补不到有效核对留在待核` },
      ...((raw.timeline ?? []) as TimelineEvent[])
    ],
    outbox: [],
    writeFailures: false
  };
}

const STORAGE_KEY = 'regatta-control-v2';
const LEGACY_KEY = 'regatta-control-v1';

function loadInitialState(): AppState {
  const rawV2 = localStorage.getItem(STORAGE_KEY);
  if (rawV2) {
    const parsed = JSON.parse(rawV2) as AppState;
    if (parsed.schemaVersion === 2) return parsed;
    return migrateV1(parsed as unknown as Record<string, unknown>);
  }
  const rawV1 = localStorage.getItem(LEGACY_KEY);
  if (rawV1) return migrateV1(JSON.parse(rawV1) as Record<string, unknown>);
  return buildInitialState();
}

export const {
  setRaceStatus,
  saveResult,
  publishResult,
  denyMeasurement,
  registerRetryable,
  removeOutbox,
  recordConflict,
  applyMeasurement,
  setWriteFailures,
  addProtest,
  transitionProtest
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware),
  preloadedState: { regatta: loadInitialState() }
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
