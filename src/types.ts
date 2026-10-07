export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type MeasurementKind = 'certificate' | 'weighing';
export type ClearanceStatus = 'cleared' | 'pending';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** 船员重量上限（公斤），放行依据的一部分 */
  weightLimitKg: number;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
}

/** 丈量记录：证书登记或船员称重，按帆号挂到参赛条目上 */
export interface MeasurementRecord {
  id: string;
  tempId?: string;
  kind: MeasurementKind;
  sailNo: string;
  // 证书字段
  certificateNo?: string;
  validFrom?: string;
  validUntil?: string;
  // 称重字段
  crewWeightKg?: number;
  // 审计字段
  measuredAt: string;
  measurerId: string;
  measurerName: string;
  /** 同一艘船同一类丈量的乐观锁版本，先写入者 +1 */
  version: number;
}

/** 后到的称重提交被挡回时拿到的冲突号 */
export interface MeasurementConflict {
  conflictNo: string;
  tempId: string;
  sailNo: string;
  rejectedWeightKg: number;
  rejectedAt: string;
  loserMeasurerId: string;
  loserMeasurerName: string;
  winnerMeasurerName: string;
  baseVersion: number;
  currentRecordId: string;
  currentReading: number;
  currentMeasuredAt: string;
}

/** 还没落地（写入失败）的登记，留在发件盒里重试 */
export interface PendingWrite {
  tempId: string;
  draft: MeasurementDraft;
  measurerId: string;
  measurerName: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface MeasurementDraft {
  kind: MeasurementKind;
  sailNo: string;
  certificateNo?: string;
  validFrom?: string;
  validUntil?: string;
  crewWeightKg?: number;
  measuredAt: string;
  /** 提交人开单时看到的版本号；与当前版本不一致即并发冲突 */
  baseVersion: number;
}

/** 放行依据一行：参赛条目 × 证书 × 称重 × 成绩，同一份核对快照 */
export interface ClearanceRow {
  raceId: string;
  entryId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  netSeconds: number;
  certificateRecordId?: string;
  certificateNo?: string;
  weighingRecordId?: string;
  crewWeightKg?: number;
  certificateOk: boolean;
  weightOk: boolean;
  status: ClearanceStatus;
  reasons: string[];
  /** 升级时按比赛当天记录补档出来的快照 */
  backfilled: boolean;
  evaluatedAt: string;
}

export interface RankedEntry {
  entryId: string;
  boat: string;
  sailNo: string;
  netSeconds: number;
  rank: number;
}

/** 已发布的成绩版次：正式 / 更正，旧版作废后原样留档 */
export interface ResultVersion {
  id: string;
  raceId: string;
  serial: number;
  kind: 'official' | 'correction';
  status: 'current' | 'superseded';
  publishedAt: string;
  supersededAt?: string;
  reason: string;
  rankings: RankedEntry[];
  pendingSailNos: string[];
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'measurement' | 'system';
  message: string;
}
