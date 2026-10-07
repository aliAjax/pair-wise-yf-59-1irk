import type { ClearanceRow, MeasurementRecord, Race, RaceEntry } from './types';
import { evaluateRow, pickCertificate, pickWeighing } from './clearance';

/**
 * v1 的旧数据没有放行检验快照，升级时按比赛当天最近的丈量记录补一版：
 * 比赛当天有覆盖比赛时点的证书、且当天最近称重不超限的放行；补不到的留在待核。
 */
export function backfillClearance(
  race: Race,
  entries: RaceEntry[],
  legacyRecords: MeasurementRecord[],
  migratedAt: string
): ClearanceRow[] {
  return entries.map((entry) => {
    const row = evaluateRow(race, entry, legacyRecords, migratedAt);
    row.backfilled = true;
    if (row.status === 'cleared') {
      row.reasons = ['由旧数据按比赛当天最近记录补档'];
      return row;
    }
    const hasCert = pickCertificate(legacyRecords, entry.sailNo, race.startsAt);
    const sameDayWeighing = pickWeighing(legacyRecords, entry.sailNo, race.startsAt, true);
    const anyWeighing = pickWeighing(legacyRecords, entry.sailNo, race.startsAt, false);
    const notes: string[] = [];
    if (!hasCert) notes.push('旧数据无覆盖比赛时点的有效证书，补档后留在待核');
    if (!anyWeighing) notes.push('旧数据无称重记录，补档后留在待核');
    else if (!sameDayWeighing) notes.push('比赛当天无称重，旧称重不采用，留在待核');
    else if (row.crewWeightKg != null && row.crewWeightKg > race.weightLimitKg) notes.push(`补档称重 ${row.crewWeightKg}kg 超过上限，留在待核`);
    row.reasons = notes.length ? notes : row.reasons;
    return row;
  });
}
