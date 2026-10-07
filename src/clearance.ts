import type {
  ClearanceRow,
  MeasurementKind,
  MeasurementRecord,
  Race,
  RaceEntry,
  RankedEntry,
  ResultVersion
} from './types';

/** 比赛当天（按当地日历日，与起航同一自然日） */
export function isRaceDay(atIso: string, raceStartsAt: string): boolean {
  return new Date(atIso).toDateString() === new Date(raceStartsAt).toDateString();
}

/** 证书必须在比赛时点仍然有效 */
export function certificateCoversRace(record: MeasurementRecord | undefined, raceStartsAt: string): boolean {
  if (!record || record.kind !== 'certificate' || !record.validFrom || !record.validUntil) return false;
  const start = new Date(raceStartsAt).getTime();
  return new Date(record.validFrom).getTime() <= start && start <= new Date(record.validUntil).getTime();
}

function recordTime(a: MeasurementRecord, b: MeasurementRecord): number {
  return new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime();
}

/** 当前生效证书：覆盖比赛时点的最新登记 */
export function pickCertificate(records: MeasurementRecord[], sailNo: string, raceStartsAt: string): MeasurementRecord | undefined {
  return records
    .filter((r) => r.sailNo === sailNo && r.kind === 'certificate' && certificateCoversRace(r, raceStartsAt))
    .sort(recordTime)[0];
}

/** 比赛当天最近一次称重；当天没有则回退到最近一次（升级补档用） */
export function pickWeighing(
  records: MeasurementRecord[],
  sailNo: string,
  raceStartsAt: string,
  requireRaceDay = false
): MeasurementRecord | undefined {
  const weighings = records
    .filter((r) => r.sailNo === sailNo && r.kind === 'weighing' && typeof r.crewWeightKg === 'number')
    .sort(recordTime);
  if (requireRaceDay) return weighings.find((r) => isRaceDay(r.measuredAt, raceStartsAt));
  return weighings[0];
}

/** 下一个称重版本号 */
export function nextVersion(records: MeasurementRecord[], sailNo: string, kind: MeasurementKind): number {
  return records.filter((r) => r.sailNo === sailNo && r.kind === kind).reduce((max, r) => Math.max(max, r.version), 0) + 1;
}

export function currentVersion(records: MeasurementRecord[], sailNo: string, kind: MeasurementKind): number {
  return records.filter((r) => r.sailNo === sailNo && r.kind === kind).reduce((max, r) => Math.max(max, r.version), 0);
}

/** 一条放行依据：开赛前按比赛时点核对证书与船员重量 */
export function evaluateRow(
  race: Race,
  entry: RaceEntry,
  records: MeasurementRecord[],
  evaluatedAt: string,
  options: { backfilled?: boolean; reasons?: string[] } = {}
): ClearanceRow {
  const certificate = pickCertificate(records, entry.sailNo, race.startsAt);
  const weighing = pickWeighing(records, entry.sailNo, race.startsAt, true);
  const certificateOk = Boolean(certificate);
  const weightOk = typeof weighing?.crewWeightKg === 'number' && weighing.crewWeightKg <= race.weightLimitKg;
  const reasons: string[] = [];
  if (!certificateOk) reasons.push('缺少覆盖比赛时点的有效丈量证书');
  if (weighing == null) reasons.push('缺少比赛当天称重记录');
  else if (!weightOk) reasons.push(`船员重量 ${weighing.crewWeightKg}kg 超过上限 ${race.weightLimitKg}kg`);
  return {
    raceId: race.id,
    entryId: entry.id,
    boat: entry.boat,
    sailNo: entry.sailNo,
    skipper: entry.skipper,
    netSeconds: entry.elapsedSeconds + entry.penaltySeconds,
    certificateRecordId: certificate?.id,
    certificateNo: certificate?.certificateNo,
    weighingRecordId: weighing?.id,
    crewWeightKg: weighing?.crewWeightKg,
    certificateOk,
    weightOk,
    status: certificateOk && weightOk ? 'cleared' : 'pending',
    reasons: reasons.length ? reasons : (options.reasons ?? []),
    backfilled: Boolean(options.backfilled),
    evaluatedAt
  };
}

/** 每场比赛的完整放行依据：待核船只不进入正式名次 */
export function buildClearance(race: Race, entries: RaceEntry[], records: MeasurementRecord[], evaluatedAt: string, backfilledEntryIds: string[] = []): ClearanceRow[] {
  return entries.map((entry) => {
    const row = evaluateRow(race, entry, records, evaluatedAt);
    if (backfilledEntryIds.includes(entry.id)) {
      row.backfilled = true;
    }
    return row;
  });
}

/** 只给已放行船只排名；待核船只单列，不占正式名次 */
export function computeRankings(rows: ClearanceRow[]): RankedEntry[] {
  return rows
    .filter((r) => r.status === 'cleared')
    .sort((a, b) => a.netSeconds - b.netSeconds)
    .map((r, index) => ({ entryId: r.entryId, boat: r.boat, sailNo: r.sailNo, netSeconds: r.netSeconds, rank: index + 1 }));
}

export function rankingsSignature(rankings: RankedEntry[]): string {
  return rankings.map((r) => `${r.entryId}:${r.netSeconds}#${r.rank}`).join('|');
}

export function rankingsEqual(a: RankedEntry[], b: RankedEntry[]): boolean {
  return rankingsSignature(a) === rankingsSignature(b);
}

export function pendingSailNos(rows: ClearanceRow[]): string[] {
  return rows.filter((r) => r.status === 'pending').map((r) => r.sailNo);
}

/** 找到引用了某条丈量记录的放行快照 */
export function rowsUsingRecord(rows: ClearanceRow[], recordId: string): ClearanceRow[] {
  return rows.filter((r) => r.certificateRecordId === recordId || r.weighingRecordId === recordId);
}

export function netLabel(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 新的成绩版次（自动重算时调用） */
export function describeVersionKind(version: ResultVersion): string {
  return version.kind === 'official' ? '正式成绩' : '更正成绩';
}
