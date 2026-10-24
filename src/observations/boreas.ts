import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byteDigest } from '../data-os/evidence-capture';
import { captureObservationArtifact } from './fixture';
import { BOREAS_SEQUENCE, downloadBoreasSlice } from './boreas-source';
import { parseBundle, transform, type ObservationBundle, type Transform, type Vec3 } from './contracts';
import { apply } from './replay';
import { ObservationReplayService, type ReplayRequest } from './service';
const multiply = (a: number[][], b: number[][]) => a.map(row => b[0].map((_, j) => row.reduce((sum, x, k) => sum + x * b[k][j], 0)));
export function compose(a: Transform, b: Transform): Transform { return { rotation: multiply(a.rotation, b.rotation), translationM: apply(a, b.translationM) }; }
export function inverse(t: Transform): Transform { const rotation = t.rotation[0].map((_, i) => t.rotation.map(row => row[i])); return { rotation, translationM: rotation.map(row => -row.reduce((sum, x, i) => sum + x * t.translationM[i], 0)) as Vec3 }; }
export function decimalSecondsNs(value: string) {
  if (!/^[0-9]+(?:\.[0-9]{1,9})?$/.test(value)) throw new Error('Unsupported timestamp precision.');
  const [whole, fraction = ''] = value.split('.'); return (BigInt(whole) * BigInt(1000000000) + BigInt(fraction.padEnd(9, '0'))).toString();
}
function matrix(bytes: Buffer): number[][] {
  const rows = bytes.toString('utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number));
  if (rows.length !== 4 || rows.some(row => row.length !== 4 || row.some(x => !Number.isFinite(x))) || rows[3].some((x, i) => Math.abs(x - (i === 3 ? 1 : 0)) > 1e-10)) throw new Error('Unsupported calibration matrix.');
  return rows;
}
function rigid(m: number[][]): Transform { const t = { rotation: m.slice(0, 3).map(row => row.slice(0, 3)), translationM: m.slice(0, 3).map(row => row[3]) as Vec3 }; transform(t); return t; }
function rows(bytes: Buffer) { return bytes.toString('utf8').split('\n').slice(1, -1).filter(Boolean).map(line => line.trim().split(',')); }
function atMicroseconds(bytes: Buffer, timestamp: string) { const row = rows(bytes).find(row => row[0] === timestamp); if (!row) throw new Error('Capture pose absent from bounded source slice.'); return row; }
function nearSeconds(bytes: Buffer, nanos: string) {
  const all = rows(bytes), target = BigInt(nanos);
  const distance = (row: string[]) => { const d = BigInt(decimalSecondsNs(row[0])) - target; return d < BigInt(0) ? -d : d; };
  if (!all.length || BigInt(decimalSecondsNs(all[0][0])) > target || BigInt(decimalSecondsNs(all[all.length - 1][0])) < target) throw new Error('Bounded context data does not cover selected capture time.');
  return all.reduce((best, row) => distance(row) < distance(best) ? row : best);
}
/** Boreas' documented passive roll * pitch * yaw convention, not generic active XYZ Euler angles. */
function poseFromRow(row: string[]): Transform {
  const values = row.slice(1, 10).map(Number); if (values.length !== 9 || values.some(x => !Number.isFinite(x))) throw new Error('Invalid recorded pose.');
  const [x, y, z, , , , roll, pitch, yaw] = values;
  const r = [[1, 0, 0], [0, Math.cos(roll), Math.sin(roll)], [0, -Math.sin(roll), Math.cos(roll)]];
  const p = [[Math.cos(pitch), 0, -Math.sin(pitch)], [0, 1, 0], [Math.sin(pitch), 0, Math.cos(pitch)]];
  const h = [[Math.cos(yaw), Math.sin(yaw), 0], [-Math.sin(yaw), Math.cos(yaw), 0], [0, 0, 1]];
  const t = { rotation: multiply(multiply(r, p), h), translationM: [x, y, z] as Vec3 }; transform(t); return t;
}
export async function boreasReplay(root: string, downloadDirectory: string) {
  const manifest = await downloadBoreasSlice(downloadDirectory), at = manifest.capturedAt;
  const bytes = (id: string) => { const f = manifest.files.find(f => f.id === id)!; const b = readFileSync(join(downloadDirectory, f.filename)); if (byteDigest(b) !== f.digest) throw new Error('Source bytes changed.'); return b; };
  const artifacts: ObservationBundle['artifacts'] = manifest.files.map(f => ({ id: f.id, role: f.id.includes('poses') ? 'TRAJECTORY' : ['body-lidar', 'camera-lidar', 'camera-projection'].includes(f.id) ? 'CALIBRATION' : 'RAW',
    reference: captureObservationArtifact(root, `boreas-${f.id}`, f.id === 'camera' ? 'image/png' : 'application/octet-stream', bytes(f.id), 'PUBLIC_DATASET', at) }));
  const derivation = { method: 'BOREAS_BOUNDED_CONTEXT_ADAPTER', version: '1.0.0', source: manifest,
    documentation: 'https://github.com/utiasASRL/pyboreas/blob/master/DATA_REFERENCE.md',
    bodyFrame: 'Applanix reference frame; sensor mounting rotations retained from supplied matrices.',
    worldFrame: 'Boreas ENU_ref, shared dataset reference; this adapter does not independently reconstruct its geographic datum.',
    clockMapping: 'Dataset documentation declares Unix UTC timestamps. Sensor pose timestamps are microseconds; gps_post_process and imu_raw timestamps are decimal seconds despite the GPSTime column label.',
    cameraMount: 'T_body_camera = T_applanix_lidar * inverse(T_camera_lidar)',
    bodyPose: 'T_world_body = T_world_sensor * inverse(T_body_sensor); avoids applying mounting offsets twice.',
    covariance: 'Not supplied in selected files; retained as unknown.', calibrationValidity: 'Restricted by adapter to this selected capture window; not independently certified.' };
  artifacts.push({ id: 'derivation', role: 'CALIBRATION', reference: captureObservationArtifact(root, 'boreas-derivation', 'application/json', Buffer.from(JSON.stringify(derivation)), 'PUBLIC_DATASET', at) });
  const cameraTime = '1606417097547313', lidarTime = '1606417097502930';
  const cameraNs = (BigInt(cameraTime) * BigInt(1000)).toString(), lidarNs = (BigInt(lidarTime) * BigInt(1000)).toString();
  const bodyLidar = rigid(matrix(bytes('body-lidar'))), bodyCamera = compose(bodyLidar, inverse(rigid(matrix(bytes('camera-lidar')))));
  const p = matrix(bytes('camera-projection'));
  if (p[0][1] !== 0 || p[0][3] !== 0 || p[1][0] !== 0 || p[1][3] !== 0 || p[2].some((x, i) => x !== (i === 2 ? 1 : 0))) throw new Error('Camera projection is outside the rectified pinhole scope.');
  const from = (BigInt(lidarNs) - BigInt(1000000000)).toString(), until = (BigInt(cameraNs) + BigInt(1000000000)).toString();
  const calibration = (sensorId: string, sensorToBody: Transform): ObservationBundle['calibrations'][number] => ({ id: `${sensorId}-mount`, sensorId, version: BOREAS_SEQUENCE, artifactId: 'derivation', validFromReferenceNs: from, validUntilReferenceNs: until, sensorToBody, covariance: null,
    intrinsics: sensorId === 'camera' ? { model: 'RECTIFIED_PINHOLE', fx: p[0][0], fy: p[1][1], cx: p[0][2], cy: p[1][2] } : null });
  const pose = (sensor: string, time: string, mount: Transform): ObservationBundle['poses'][number] => ({ id: `${sensor}-pose`, sessionId: BOREAS_SEQUENCE, referenceTimeNs: (BigInt(time) * BigInt(1000)).toString(), bodyToWorld: compose(poseFromRow(atMicroseconds(bytes(`${sensor}-poses`), time)), inverse(mount)), covariance: null, velocityWorldMps: null, artifactId: `${sensor}-poses` });
  const context = (id: string, sensorId: string, time: string, artifactId: string, poseId: string | null): ObservationBundle['observations'][number] => ({ id, sessionId: BOREAS_SEQUENCE, sensorId, clockId: 'dataset-clock', captureTimeNs: time, poseId, artifactId, selector: id, processing: { method: 'BOREAS_BOUNDED_CONTEXT_ADAPTER', version: '1.0.0', artifactIds: [artifactId, 'derivation'] }, measurement: { kind: 'CONTEXT' }, association: { objectId: null, status: 'UNKNOWN', artifactId: null, probability: null }, gnss: sensorId === 'gnss' ? { solutionStatus: 'POST_PROCESSED', correctionSource: null, correctionAgeSeconds: null } : null });
  const gnssRow = nearSeconds(bytes('gnss'), cameraNs), imuRow = nearSeconds(bytes('imu'), cameraNs);
  const scan = bytes('lidar'); if (scan.length % 24 !== 0) throw new Error('LiDAR payload is not six float32 fields per point.');
  const point = [scan.readFloatLE(0), scan.readFloatLE(4), scan.readFloatLE(8)] as Vec3, offset = scan.readFloatLE(20);
  if (!point.every(Number.isFinite) || !Number.isFinite(offset) || Math.abs(offset) > 1) throw new Error('Invalid selected LiDAR sample.');
  const pointNs = (BigInt(lidarNs) + BigInt(Math.round(offset * 1e9))).toString();
  const pointObservation = context('lidar-point-0', 'lidar', pointNs, 'lidar', 'lidar-pose'); pointObservation.measurement = { kind: 'POINT3D', pointM: point }; pointObservation.selector = 'float32 little-endian row 0; XYZ fields 0..2; per-point seconds offset field 5 rounded to nanoseconds';
  const observations = [context('camera-frame', 'camera', cameraNs, 'camera', 'camera-pose'), context('lidar-scan', 'lidar', lidarNs, 'lidar', 'lidar-pose'), pointObservation,
    context('gnss-context', 'gnss', decimalSecondsNs(gnssRow[0]), 'gnss', null), context('imu-context', 'imu', decimalSecondsNs(imuRow[0]), 'imu', null)];
  observations.find(o => o.id === 'gnss-context')!.selector = `CSV row timestamp ${gnssRow[0]}; post-processed GNSS/INS solution, not raw GNSS`;
  observations.find(o => o.id === 'imu-context')!.selector = `CSV row timestamp ${imuRow[0]}; raw IMU axes x backwards, y left, z up`;
  const bundle = parseBundle({ schema: 'payload.observation-bundle.v1', id: 'boreas-bounded-replay', classification: 'RECORDED',
    worldFrame: { id: 'boreas-enu-ref', units: 'm', axes: 'RIGHT_HANDED', definition: derivation.worldFrame, artifactId: 'derivation' },
    bodyFrame: { id: 'applanix', definition: derivation.bodyFrame, artifactId: 'derivation' },
    referenceClock: { id: 'boreas-utc', basis: 'UNIX_UTC', definition: derivation.clockMapping }, artifacts,
    sensors: ['CAMERA', 'LIDAR', 'GNSS', 'IMU'].map(modality => ({ id: modality.toLowerCase(), modality, frameId: `${modality.toLowerCase()}-frame`, definition: modality === 'IMU' ? 'Raw IMU body: x backwards, y left, z up; mounting relation unresolved.' : `Boreas ${modality} frame; see exact calibration and derivation artifacts.`, calibrationId: ['CAMERA', 'LIDAR'].includes(modality) ? `${modality.toLowerCase()}-mount` : null })),
    clocks: [{ id: 'dataset-clock', basis: 'UNIX_UTC', offsetToReferenceNs: '0', uncertaintyNs: null, validFromNs: from, validUntilNs: until, artifactId: 'derivation' }],
    calibrations: [calibration('camera', bodyCamera), calibration('lidar', bodyLidar)], poses: [pose('camera', cameraTime, bodyCamera), pose('lidar', lidarTime, bodyLidar)], observations });
  const source = captureObservationArtifact(root, 'boreas-bundle', 'application/json', Buffer.from(JSON.stringify(bundle, null, 2)), 'PUBLIC_DATASET', at);
  const request: ReplayRequest = { schema: 'payload.observation-replay-request.v1', requestId: 'boreas-bounded-replay-1', purpose: 'OBSERVATION_REPLAY', source, pairs: [{ id: 'unannotated-cross-sensor', leftId: 'lidar-point-0', rightId: 'camera-frame' }] };
  return { manifest, bundle, request, analysis: new ObservationReplayService(root).submit(request), limitation: 'One recorded session; no independently identified object correspondence or pose at the selected individual LiDAR point time. Field accuracy is not established.' };
}
