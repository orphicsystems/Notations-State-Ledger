import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { byteDigest } from '../data-os/evidence-capture';
export const BOREAS_SEQUENCE = 'boreas-2020-11-26-13-58';
const base = `https://boreas.s3.amazonaws.com/${BOREAS_SEQUENCE}/`;
export const BOREAS_FILES = [
  { id: 'camera', key: 'camera/1606417097547313.png', maxBytes: 3 * 1024 * 1024, range: false },
  { id: 'lidar', key: 'lidar/1606417097502930.bin', maxBytes: 6 * 1024 * 1024, range: false },
  { id: 'camera-poses', key: 'applanix/camera_poses.csv', maxBytes: 65536, range: true },
  { id: 'lidar-poses', key: 'applanix/lidar_poses.csv', maxBytes: 65536, range: true },
  { id: 'gnss', key: 'applanix/gps_post_process.csv', maxBytes: 2 * 1024 * 1024, range: true },
  { id: 'imu', key: 'applanix/imu_raw.csv', maxBytes: 1024 * 1024, range: true },
  { id: 'body-lidar', key: 'calib/T_applanix_lidar.txt', maxBytes: 4096, range: false },
  { id: 'camera-lidar', key: 'calib/T_camera_lidar.txt', maxBytes: 4096, range: false },
  { id: 'camera-projection', key: 'calib/P_camera.txt', maxBytes: 4096, range: false },
] as const;
export interface BoreasManifest { schema: 'payload.boreas-slice.v1'; sequence: string; capturedAt: string; sourceLicense: string; files: { id: string; url: string; filename: string; byteLength: number; digest: string; contentRange: string | null; etag: string | null }[] }
/** Fixed public source and hard byte limits; no arbitrary URL fetching or whole-sequence sync. */
export async function downloadBoreasSlice(directory: string): Promise<BoreasManifest> {
  const manifestPath = join(directory, 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BoreasManifest;
    if (m.schema !== 'payload.boreas-slice.v1' || m.sequence !== BOREAS_SEQUENCE || m.files.length !== BOREAS_FILES.length) throw new Error('Invalid saved Boreas slice.');
    for (const spec of BOREAS_FILES) {
      const f = m.files.find(f => f.id === spec.id);
      if (!f || f.url !== base + spec.key || f.filename !== `${spec.id}.bin`) throw new Error('Invalid saved sample binding.');
      const bytes = readFileSync(join(directory, f.filename));
      if (bytes.length > spec.maxBytes || (spec.range && bytes.length !== spec.maxBytes) || bytes.length !== f.byteLength || byteDigest(bytes) !== f.digest) throw new Error('Saved sample bytes no longer verify.');
    }
    return m;
  }
  mkdirSync(directory, { recursive: true });
  const files: BoreasManifest['files'] = [];
  for (const spec of BOREAS_FILES) {
    const response = await fetch(base + spec.key, { headers: spec.range ? { Range: `bytes=0-${spec.maxBytes - 1}` } : {}, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (response.status !== (spec.range ? 206 : 200) || !response.body) throw new Error(`Bounded source request refused: ${spec.id}`);
    const contentRange = response.headers.get('content-range');
    if (spec.range && (!contentRange || !new RegExp(`^bytes 0-${spec.maxBytes - 1}/[0-9]+$`).test(contentRange))) throw new Error('Source did not honor the exact byte range.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > spec.maxBytes) { await reader.cancel(); throw new Error('Source exceeded the byte limit.'); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks), filename = `${spec.id}.bin`;
    if (!bytes.length || (spec.range && bytes.length !== spec.maxBytes)) throw new Error('Truncated source range.');
    const target = join(directory, filename);
    if (existsSync(target)) { if (!readFileSync(target).equals(bytes)) throw new Error('An interrupted download retained different bytes; preserve it and use a new directory.'); }
    else writeFileSync(target, bytes, { flag: 'wx' });
    files.push({ id: spec.id, url: base + spec.key, filename, byteLength: bytes.length, digest: byteDigest(bytes), contentRange, etag: response.headers.get('etag') });
  }
  const manifest: BoreasManifest = { schema: 'payload.boreas-slice.v1', sequence: BOREAS_SEQUENCE, capturedAt: new Date().toISOString(), sourceLicense: 'CC-BY-4.0; https://github.com/utiasASRL/pyboreas/blob/master/DATA_LICENSE.md', files };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}
