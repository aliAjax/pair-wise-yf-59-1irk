export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type InspectionStatus = 'confirmed' | 'pending';
export type NoticeType = 'success' | 'error' | 'info';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
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
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

// 丈量证书
export interface Certificate {
  number: string;
  issuedBy: string;
  validFrom: string;
  validTo: string;
}

// 称重读数（带版本号用于乐观并发控制）
export interface WeightReading {
  id: string;
  boatId: string;
  weightKg: number;
  weighedAt: string;
  measurerId: string;
  measurerName: string;
  version: number;
}

// 同一艘船的丈量记录
export interface MeasurementRecord {
  sailNo: string;
  boat: string;
  certificate: Certificate | null;
  weightReadings: WeightReading[];
  currentVersion: number;
}

// 赛前检验快照（放行依据）
export interface InspectionSnapshot {
  id: string;            // `${raceId}:${entryId}`
  raceId: string;
  entryId: string;
  sailNo: string;
  status: InspectionStatus;
  certValid: boolean;
  weightOk: boolean;
  certNumber: string | null;
  weightKg: number | null;
  weightLimitKg: number;
  checkedAt: string;
  migrated: boolean;
}

// 一版成绩（正式或更正留档）
export interface ResultVersionRow {
  entryId: string;
  boat: string;
  rank: number | null;   // null = 待核，不占正式名次
  totalSeconds: number;
  status: ResultStatus;
}

export interface ResultVersion {
  id: string;
  raceId: string;
  version: number;
  type: 'official' | 'corrected';
  publishedAt: string;
  supersededAt?: string;
  rows: ResultVersionRow[];
}

// 待重试的登记（写入失败后留住没落地的登记）
export interface PendingRegistration {
  id: string;
  kind: 'weight' | 'certificate';
  sailNo: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retries: number;
  lastError: string;
  status: 'pending' | 'retrying';
}

export interface ConflictNotice {
  sailNo: string;
  conflictNo: string;
  currentWeightKg: number | null;
  currentVersion: number;
  expectedVersion: number;
  at: string;
}

export interface Notice {
  type: NoticeType;
  message: string;
  at: string;
}
