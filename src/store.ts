import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  ConflictNotice, InspectionSnapshot, MeasurementRecord, Notice, PendingRegistration,
  Protest, ProtestStatus, Race, RaceEntry, ResultVersion, ResultVersionRow, TimelineEvent, WeightReading
} from './types';
import { raceApi, isMeasurer, OFFICIALS } from './api';
import { inspectRecord, totalSeconds } from './domain';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  measurements: Record<string, MeasurementRecord>;
  inspections: InspectionSnapshot[];
  resultVersions: ResultVersion[];
  outbox: PendingRegistration[];
  currentOfficialId: string;
  weightLimitKg: number;
  migrationVersion: number;
  lastConflict: ConflictNotice | null;
  lastNotice: Notice | null;
}

const WEIGHT_LIMIT_KG = 85;

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'provisional', note: '' }
];

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

function reading(sailNo: string, weightKg: number, hoursAgo: number, version: number, measurerId: string, measurerName: string): WeightReading {
  return {
    id: crypto.randomUUID(),
    boatId: sailNo,
    weightKg,
    weighedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
    measurerId,
    measurerName,
    version
  };
}

// 初始丈量记录：CHN 218 证书有效且重量合格（升级补录后确认）；CHN 106 超重；CHN 077 无证书（均留待核）
const initialMeasurements: Record<string, MeasurementRecord> = {
  'CHN 218': {
    sailNo: 'CHN 218', boat: '海风号',
    certificate: { number: 'CERT-2026-0218', issuedBy: '中国帆协', validFrom: '2026-01-01', validTo: '2026-12-31' },
    weightReadings: [
      reading('CHN 218', 80, 3, 1, 'o4', '高岚'),
      reading('CHN 218', 78, 1, 2, 'o4', '高岚')
    ],
    currentVersion: 2
  },
  'CHN 106': {
    sailNo: 'CHN 106', boat: '远岚号',
    certificate: { number: 'CERT-2026-0106', issuedBy: '中国帆协', validFrom: '2026-01-01', validTo: '2026-12-31' },
    weightReadings: [reading('CHN 106', 86, 2, 1, 'o5', '何峻')],
    currentVersion: 1
  },
  'CHN 077': {
    sailNo: 'CHN 077', boat: '北辰号',
    certificate: null,
    weightReadings: [reading('CHN 077', 82, 2, 1, 'o4', '高岚')],
    currentVersion: 1
  }
};

const initialState: AppState = {
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  measurements: initialMeasurements,
  inspections: [],
  resultVersions: [],
  outbox: [],
  currentOfficialId: 'o4',
  weightLimitKg: WEIGHT_LIMIT_KG,
  migrationVersion: 0,
  lastConflict: null,
  lastNotice: null
};

function buildSnapshot(
  measurements: Record<string, MeasurementRecord>,
  race: Race,
  entry: RaceEntry,
  weightLimitKg: number,
  migrated: boolean
): InspectionSnapshot {
  const record = measurements[entry.sailNo];
  const result = inspectRecord(record, race, weightLimitKg, migrated ? 'nearestOnDay' : 'raceTime');
  return {
    id: `${race.id}:${entry.id}`,
    raceId: race.id,
    entryId: entry.id,
    sailNo: entry.sailNo,
    status: result.status,
    certValid: result.certValid,
    weightOk: result.weightOk,
    certNumber: result.certNumber,
    weightKg: result.weightKg,
    weightLimitKg,
    checkedAt: new Date().toISOString(),
    migrated
  };
}

// 升级补录：旧数据没有检验快照，按比赛当天最近的记录补上，补不到的留在待核
function runMigration(state: AppState): void {
  if (state.migrationVersion >= 1) return;
  state.measurements ??= {};
  const confirmed: string[] = [];
  const pending: string[] = [];
  for (const race of state.races) {
    for (const entry of state.entries) {
      const snap = buildSnapshot(state.measurements, race, entry, state.weightLimitKg, true);
      state.inspections.push(snap);
      if (snap.status === 'confirmed') confirmed.push(entry.boat);
      else pending.push(entry.boat);
    }
  }
  state.migrationVersion = 1;
  state.timeline.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    type: 'system',
    message: `升级完成：已按比赛当天最近记录补录 ${confirmed.length} 艘确认船（${confirmed.join('、') || '无'}），${pending.length} 艘补不到的留在待核（${pending.join('、') || '无'}）`
  });
}

function pushNotice(state: AppState, type: Notice['type'], message: string): void {
  state.lastNotice = { type, message, at: new Date().toISOString() };
}

// 证书/重量更新后：重检所有场次，名次作废重算，已发布成绩另存更正版
function invalidateRace(state: AppState, raceId: string): void {
  const race = state.races.find((item) => item.id === raceId);
  const versions = state.resultVersions.filter((v) => v.raceId === raceId);
  const latest = versions[versions.length - 1];
  if (latest && latest.type === 'official') {
    latest.type = 'corrected';
    latest.supersededAt = new Date().toISOString();
    for (const entry of state.entries) {
      if (entry.resultStatus === 'official') entry.resultStatus = 'corrected';
    }
    state.timeline.unshift({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      type: 'system',
      message: `${race?.name ?? ''} 证书/重量更新，旧名次作废重算，已发布成绩另存更正版 v${latest.version}`
    });
  }
}

function reinspectAndInvalidate(state: AppState): void {
  for (const race of state.races) {
    let changed = false;
    for (const entry of state.entries) {
      const next = buildSnapshot(state.measurements, race, entry, state.weightLimitKg, false);
      const idx = state.inspections.findIndex((i) => i.id === next.id);
      const prev = idx >= 0 ? state.inspections[idx] : undefined;
      if (!prev || prev.status !== next.status || prev.weightKg !== next.weightKg || prev.certValid !== next.certValid) {
        changed = true;
        if (prev && prev.status !== next.status) {
          state.timeline.unshift({
            id: crypto.randomUUID(),
            time: new Date().toISOString(),
            type: 'system',
            message: `${entry.boat}（${entry.sailNo}）${next.status === 'confirmed' ? '已核对确认，进入正式排名' : '转入待核，不占正式名次'}`
          });
        }
      }
      if (idx >= 0) state.inspections[idx] = next;
      else state.inspections.push(next);
    }
    if (changed) invalidateRace(state, race.id);
  }
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      entry.resultStatus = action.payload.official ? 'official' : changed ? 'corrected' : 'provisional';
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒` });
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
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
        }
      }
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}` });
    },
    setCurrentOfficial(state, action: PayloadAction<string>) {
      state.currentOfficialId = action.payload;
    },
    // 赛前核对：按比赛时点重检所有场次
    runInspection(state) {
      reinspectAndInvalidate(state);
      const confirmed = state.inspections.filter((i) => i.status === 'confirmed').length;
      const pending = state.inspections.filter((i) => i.status === 'pending').length;
      pushNotice(state, 'info', `赛前核对完成：${confirmed} 艘确认，${pending} 艘待核`);
    },
    // 登记称重（乐观并发：先写入生效，后到的看到当前读数并拿到冲突号）
    registerWeight(state, action: PayloadAction<{ sailNo: string; weightKg: number; expectedVersion: number; simulateFailure?: boolean; staleVersion?: boolean }>) {
      const me = isMeasurer(state.currentOfficialId);
      if (!me) {
        pushNotice(state, 'error', '越权登记被挡回：当前身份不是丈量员，无权登记称重');
        return;
      }
      const { sailNo, weightKg, simulateFailure } = action.payload;
      const expectedVersion = action.payload.staleVersion ? action.payload.expectedVersion - 1 : action.payload.expectedVersion;
      if (simulateFailure) {
        state.outbox.push({
          id: crypto.randomUUID(),
          kind: 'weight',
          sailNo,
          payload: { weightKg, expectedVersion },
          createdAt: new Date().toISOString(),
          retries: 0,
          lastError: '模拟写入失败：登记未落地',
          status: 'pending'
        });
        pushNotice(state, 'error', '写入失败：称重登记已留住，可在待重试队列中重试');
        return;
      }
      const record: MeasurementRecord = state.measurements[sailNo] ?? { sailNo, boat: sailNo, certificate: null, weightReadings: [], currentVersion: 0 };
      if (expectedVersion !== record.currentVersion) {
        const latest = record.weightReadings[record.weightReadings.length - 1];
        const conflictNo = `CONFLICT-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
        state.lastConflict = {
          sailNo,
          conflictNo,
          currentWeightKg: latest?.weightKg ?? null,
          currentVersion: record.currentVersion,
          expectedVersion,
          at: new Date().toISOString()
        };
        pushNotice(state, 'error', `提交冲突：您基于 v${expectedVersion} 提交，当前已到 v${record.currentVersion}，先写入的已生效`);
        return;
      }
      const reading: WeightReading = {
        id: crypto.randomUUID(),
        boatId: sailNo,
        weightKg,
        weighedAt: new Date().toISOString(),
        measurerId: state.currentOfficialId,
        measurerName: OFFICIALS.find((o) => o.id === state.currentOfficialId)?.name ?? '丈量员',
        version: record.currentVersion + 1
      };
      record.weightReadings.push(reading);
      record.currentVersion += 1;
      state.measurements[sailNo] = record;
      pushNotice(state, 'success', `称重已登记：${sailNo} ${weightKg}kg（v${record.currentVersion}）`);
      reinspectAndInvalidate(state);
    },
    // 登记证书
    registerCertificate(state, action: PayloadAction<{ sailNo: string; number: string; issuedBy: string; validFrom: string; validTo: string; simulateFailure?: boolean }>) {
      if (!isMeasurer(state.currentOfficialId)) {
        pushNotice(state, 'error', '越权登记被挡回：当前身份不是丈量员，无权登记证书');
        return;
      }
      const { sailNo, number, issuedBy, validFrom, validTo, simulateFailure } = action.payload;
      if (simulateFailure) {
        state.outbox.push({
          id: crypto.randomUUID(),
          kind: 'certificate',
          sailNo,
          payload: { number, issuedBy, validFrom, validTo },
          createdAt: new Date().toISOString(),
          retries: 0,
          lastError: '模拟写入失败：登记未落地',
          status: 'pending'
        });
        pushNotice(state, 'error', '写入失败：证书登记已留住，可在待重试队列中重试');
        return;
      }
      const record: MeasurementRecord = state.measurements[sailNo] ?? { sailNo, boat: sailNo, certificate: null, weightReadings: [], currentVersion: 0 };
      record.certificate = { number, issuedBy, validFrom, validTo };
      state.measurements[sailNo] = record;
      pushNotice(state, 'success', `证书已登记：${sailNo} ${number}`);
      reinspectAndInvalidate(state);
    },
    // 重试待重试队列中没落地的登记
    retryRegistration(state, action: PayloadAction<{ id: string }>) {
      const item = state.outbox.find((o) => o.id === action.payload.id);
      if (!item) return;
      item.retries += 1;
      item.status = 'retrying';
      const record: MeasurementRecord = state.measurements[item.sailNo] ?? { sailNo: item.sailNo, boat: item.sailNo, certificate: null, weightReadings: [], currentVersion: 0 };
      if (item.kind === 'weight') {
        const weightKg = Number(item.payload.weightKg);
        const reading: WeightReading = {
          id: crypto.randomUUID(),
          boatId: item.sailNo,
          weightKg,
          weighedAt: new Date().toISOString(),
          measurerId: state.currentOfficialId,
          measurerName: OFFICIALS.find((o) => o.id === state.currentOfficialId)?.name ?? '丈量员',
          version: record.currentVersion + 1
        };
        record.weightReadings.push(reading);
        record.currentVersion += 1;
      } else {
        record.certificate = {
          number: String(item.payload.number),
          issuedBy: String(item.payload.issuedBy),
          validFrom: String(item.payload.validFrom),
          validTo: String(item.payload.validTo)
        };
      }
      state.measurements[item.sailNo] = record;
      state.outbox = state.outbox.filter((o) => o.id !== item.id);
      pushNotice(state, 'success', `重试成功：${item.sailNo} 登记已落地`);
      reinspectAndInvalidate(state);
    },
    clearOutboxItem(state, action: PayloadAction<{ id: string }>) {
      state.outbox = state.outbox.filter((o) => o.id !== action.payload.id);
    },
    clearConflict(state) {
      state.lastConflict = null;
    },
    clearNotice(state) {
      state.lastNotice = null;
    },
    // 发布正式名次：确认船占名次，待核船不占名次，另存一版正式成绩
    publishRace(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race) return;
      const ranked: { entry: RaceEntry; rank: number }[] = [];
      const pending: RaceEntry[] = [];
      for (const entry of state.entries) {
        const snap = state.inspections.find((i) => i.id === `${race.id}:${entry.id}`);
        if (snap?.status === 'confirmed') ranked.push({ entry, rank: 0 });
        else pending.push(entry);
      }
      ranked.sort((a, b) => totalSeconds(a.entry) - totalSeconds(b.entry));
      ranked.forEach((x, i) => { x.rank = i + 1; });
      const rows: ResultVersionRow[] = [
        ...ranked.map((x) => ({ entryId: x.entry.id, boat: x.entry.boat, rank: x.rank, totalSeconds: totalSeconds(x.entry), status: 'official' as const })),
        ...pending.map((e) => ({ entryId: e.id, boat: e.boat, rank: null, totalSeconds: totalSeconds(e), status: e.resultStatus }))
      ];
      const nextVersion = state.resultVersions.filter((v) => v.raceId === race.id).reduce((m, v) => Math.max(m, v.version), 0) + 1;
      state.resultVersions.push({ id: crypto.randomUUID(), raceId: race.id, version: nextVersion, type: 'official', publishedAt: new Date().toISOString(), rows });
      for (const { entry } of ranked) entry.resultStatus = 'official';
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'result',
        message: `${race.name} 正式名次 v${nextVersion} 已发布：${ranked.length} 艘确认船占名次，${pending.length} 艘待核不占名次`
      });
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState: AppState = stored ? JSON.parse(stored) as AppState : initialState;
runMigration(preloadedState);

export const {
  setRaceStatus, saveResult, addProtest, transitionProtest, setCurrentOfficial,
  runInspection, registerWeight, registerCertificate, retryRegistration, clearOutboxItem,
  clearConflict, clearNotice, publishRace
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// 名次选择器：确认船占名次，待核船不占名次
export interface RankedRow { entry: RaceEntry; rank: number; snap: InspectionSnapshot | undefined; total: number; }
export interface PendingRow { entry: RaceEntry; snap: InspectionSnapshot | undefined; reason: string; total: number; }

export function selectRanking(state: RootState): { ranked: RankedRow[]; pending: PendingRow[] } {
  const race = state.regatta.races[0];
  const raceId = race?.id ?? 'race-1';
  const ranked: RankedRow[] = [];
  const pending: PendingRow[] = [];
  for (const entry of state.regatta.entries) {
    const snap = state.regatta.inspections.find((i) => i.id === `${raceId}:${entry.id}`);
    const total = totalSeconds(entry);
    if (snap?.status === 'confirmed') ranked.push({ entry, rank: 0, snap, total });
    else pending.push({ entry, snap, reason: pendingReason(snap), total });
  }
  ranked.sort((a, b) => a.total - b.total);
  ranked.forEach((x, i) => { x.rank = i + 1; });
  return { ranked, pending };
}

function pendingReason(snap: InspectionSnapshot | undefined): string {
  if (!snap) return '未核对';
  if (!snap.certValid && !snap.weightOk) return '证书缺失或已过期，且重量超限';
  if (!snap.certValid) return '证书缺失或已过期';
  if (!snap.weightOk) return '重量超限';
  return '待核';
}
