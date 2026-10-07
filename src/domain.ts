import type { InspectionSnapshot, MeasurementRecord, Race, WeightReading } from './types';

export function certValidAt(cert: { validFrom: string; validTo: string } | null | undefined, atTime: string): boolean {
  if (!cert) return false;
  const t = new Date(atTime).getTime();
  return new Date(cert.validFrom).getTime() <= t && t <= new Date(cert.validTo).getTime();
}

// 比赛时点当前生效的称重（比赛时间之前最近一次读数）
export function weightAt(record: MeasurementRecord | undefined, atTime: string): WeightReading | null {
  if (!record || record.weightReadings.length === 0) return null;
  const t = new Date(atTime).getTime();
  let best: WeightReading | null = null;
  for (const r of record.weightReadings) {
    const rt = new Date(r.weighedAt).getTime();
    if (rt <= t && (!best || rt > new Date(best.weighedAt).getTime())) best = r;
  }
  return best;
}

// 升级补录用：比赛当天最近的一条称重记录
export function nearestWeightOnDay(record: MeasurementRecord | undefined, day: string): WeightReading | null {
  if (!record || record.weightReadings.length === 0) return null;
  const d = new Date(day);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = dayStart + 24 * 3600_000;
  let best: WeightReading | null = null;
  let bestDist = Infinity;
  for (const r of record.weightReadings) {
    const rt = new Date(r.weighedAt).getTime();
    if (rt < dayStart || rt > dayEnd) continue;
    const dist = Math.abs(rt - d.getTime());
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  return best;
}

export interface InspectResult {
  certValid: boolean;
  weightOk: boolean;
  status: 'confirmed' | 'pending';
  certNumber: string | null;
  weightKg: number | null;
}

export function inspectRecord(
  record: MeasurementRecord | undefined,
  race: Race,
  weightLimitKg: number,
  mode: 'raceTime' | 'nearestOnDay'
): InspectResult {
  const certValid = certValidAt(record?.certificate, race.startsAt);
  const weight = mode === 'nearestOnDay' ? nearestWeightOnDay(record, race.startsAt) : weightAt(record, race.startsAt);
  const weightOk = weight != null && weight.weightKg <= weightLimitKg;
  return {
    certValid,
    weightOk,
    status: certValid && weightOk ? 'confirmed' : 'pending',
    certNumber: record?.certificate?.number ?? null,
    weightKg: weight?.weightKg ?? null
  };
}

export function pendingReason(snap: InspectionSnapshot | undefined): string {
  if (!snap) return '未核对';
  if (snap.status === 'confirmed') return '';
  if (!snap.certValid && !snap.weightOk) return '证书缺失或已过期，且重量超限';
  if (!snap.certValid) return '证书缺失或已过期';
  if (!snap.weightOk) return '重量超限';
  return '待核';
}

export function totalSeconds(entry: { elapsedSeconds: number; penaltySeconds: number }): number {
  return entry.elapsedSeconds + entry.penaltySeconds;
}
