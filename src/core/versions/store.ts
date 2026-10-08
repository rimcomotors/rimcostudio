import type { Brief } from '@/core/brief';
import type { ProviderStatus } from '@/core/providers/contracts';
export interface VersionRecord { id: string; videoId: string; title?: string; number: number; userId: string; brief: Brief; prompt: string; status: ProviderStatus; requestId: string; priceFcfa: number; videoUrl?: string; error?: string; reviewStatus?: 'pending' | 'approved' | 'rejected'; reviewReason?: string; createdAt: string }
const records = new Map<string, VersionRecord>();
export function putVersion(record: VersionRecord) { records.set(record.id, record); return record; }
export function getVersion(id: string) { return records.get(id); }
export function allVersions() { return [...records.values()]; }
export function deleteVersionsByVideoIds(videoIds: string[]) {
  const selected = new Set(videoIds);
  const matching = [...records.entries()].filter(([, record]) => selected.has(record.videoId));
  matching.forEach(([id]) => records.delete(id));
  return matching.length;
}
