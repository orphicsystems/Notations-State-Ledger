import { encodeLocalRecord, exactFields, localRecordDigest } from '../data-os/local-record';
import { id, reference, type EvidenceReference } from '../spatial/contracts';

export const MAX_REPLAY_BYTES = 1024 * 1024;
export const replayDigest = (v: unknown) => localRecordDigest(v, MAX_REPLAY_BYTES);
export type Vec3 = [number, number, number];
export type Transform = { rotation: number[][]; translationM: Vec3 };
export type Covariance = { convention: 'RIGHT_LOCAL_SE3_TX_TY_TZ_RX_RY_RZ'; matrix: number[][] } | null;
export interface ObservationBundle {
  schema: 'payload.observation-bundle.v1'; id: string; classification: 'SYNTHETIC' | 'RECORDED';
  worldFrame: { id: string; units: 'm'; axes: 'RIGHT_HANDED'; definition: string; artifactId: string };
  bodyFrame: { id: string; definition: string; artifactId: string };
  referenceClock: { id: string; basis: 'UNIX_UTC' | 'TAI' | 'GPS' | 'MONOTONIC'; definition: string };
  artifacts: { id: string; role: 'RAW' | 'CALIBRATION' | 'TRAJECTORY' | 'ANNOTATION' | 'DOCUMENTATION'; reference: EvidenceReference }[];
  sensors: { id: string; modality: 'CAMERA' | 'LIDAR' | 'RADAR' | 'GNSS' | 'IMU' | 'WHEEL_ODOMETRY'; frameId: string; definition: string; calibrationId: string | null }[];
  clocks: { id: string; basis: 'UNIX_UTC' | 'TAI' | 'GPS' | 'MONOTONIC' | 'UNKNOWN'; offsetToReferenceNs: string | null; uncertaintyNs: string | null; validFromNs: string; validUntilNs: string; artifactId: string }[];
  calibrations: { id: string; sensorId: string; version: string; artifactId: string; validFromReferenceNs: string; validUntilReferenceNs: string; sensorToBody: Transform; covariance: Covariance; intrinsics: { model: 'RECTIFIED_PINHOLE'; fx: number; fy: number; cx: number; cy: number } | null }[];
  poses: { id: string; sessionId: string; referenceTimeNs: string; bodyToWorld: Transform; covariance: Covariance; velocityWorldMps: Vec3 | null; artifactId: string }[];
  observations: { id: string; sessionId: string; sensorId: string; clockId: string; captureTimeNs: string; poseId: string | null; artifactId: string; selector: string;
    processing: { method: string; version: string; artifactIds: string[] };
    measurement: { kind: 'POINT3D'; pointM: Vec3 } | { kind: 'PIXEL'; pixel: [number, number] } | { kind: 'CONTEXT' };
    association: { objectId: string | null; status: 'ASSUMED_STATIC' | 'INDEPENDENT_STATIC_CHECK' | 'UNKNOWN'; artifactId: string | null; probability: number | null };
    gnss: { solutionStatus: 'RTK_FIXED' | 'RTK_FLOAT' | 'SINGLE' | 'POST_PROCESSED' | 'UNKNOWN'; correctionSource: string | null; correctionAgeSeconds: number | null } | null;
  }[];
}
function text(v: unknown) { if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\u0000-\u001f]/.test(v)) throw new Error('Invalid observation text.'); }
export function nanos(v: unknown, signed = false): asserts v is string {
  if (typeof v !== 'string' || !(signed ? /^-?(0|[1-9][0-9]{0,20})$/ : /^(0|[1-9][0-9]{0,20})$/).test(v) || v === '-0') throw new Error('Nanoseconds require a bounded exact decimal string.');
}
function array(v: unknown, max: number): asserts v is unknown[] { if (!Array.isArray(v) || v.length > max) throw new Error('Observation list exceeds its bound.'); }
function vector(v: unknown, n: number) { if (!Array.isArray(v) || v.length !== n || v.some(x => typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1e9)) throw new Error('Invalid finite coordinate vector.'); }
function enumeration(v: unknown, values: string[]) { if (typeof v !== 'string' || !values.includes(v)) throw new Error('Unsupported observation vocabulary.'); }
export function transform(v: unknown): asserts v is Transform {
  exactFields(v, ['rotation', 'translationM']); vector(v.translationM, 3); array(v.rotation, 3);
  if (v.rotation.length !== 3) throw new Error('Rotation must be 3 by 3.'); v.rotation.forEach(row => vector(row, 3));
  const r = v.rotation as number[][];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(r[i].reduce((sum, x, k) => sum + x * r[j][k], 0) - (i === j ? 1 : 0)) > 1e-8) throw new Error('Rotation must be orthonormal.');
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (Math.abs(det - 1) > 1e-8) throw new Error('Reflections are not rigid rotations.');
}
function covariance(v: unknown) {
  if (v === null) return;
  exactFields(v, ['convention', 'matrix']); if (v.convention !== 'RIGHT_LOCAL_SE3_TX_TY_TZ_RX_RY_RZ') throw new Error('Unsupported pose covariance convention.');
  array(v.matrix, 6); if (v.matrix.length !== 6) throw new Error('Pose covariance must be 6 by 6.'); v.matrix.forEach(row => vector(row, 6));
  const m = v.matrix as number[][];
  // Scale-normalized LDL test accepts singular PSD matrices, rejects indefinite ones.
  const scale = Math.max(1, ...m.flat().map(Math.abs)), a = m.map(row => row.map(x => x / scale));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (Math.abs(a[i][j] - a[j][i]) > 1e-12) throw new Error('Covariance must be symmetric.');
  for (let k = 0; k < 6; k++) {
    if (a[k][k] < -1e-12) throw new Error('Covariance must be positive semidefinite.');
    if (a[k][k] <= 1e-12) { for (let i = k + 1; i < 6; i++) if (Math.abs(a[i][k]) > 1e-12) throw new Error('Covariance has an invalid singular pivot.'); }
    else for (let i = k + 1; i < 6; i++) for (let j = k + 1; j < 6; j++) a[i][j] -= a[i][k] * a[k][j] / a[k][k];
  }
}
export function parseBundle(input: unknown): ObservationBundle {
  const v: unknown = JSON.parse(encodeLocalRecord(input, MAX_REPLAY_BYTES).toString('utf8'));
  exactFields(v, ['schema', 'id', 'classification', 'worldFrame', 'bodyFrame', 'referenceClock', 'artifacts', 'sensors', 'clocks', 'calibrations', 'poses', 'observations']);
  if (v.schema !== 'payload.observation-bundle.v1') throw new Error('Unsupported observation bundle.'); id(v.id); enumeration(v.classification, ['SYNTHETIC', 'RECORDED']);
  for (const [key, max] of [['artifacts', 64], ['sensors', 16], ['clocks', 16], ['calibrations', 32], ['poses', 512], ['observations', 512]] as const) {
    array(v[key], max); const ids = new Set();
    for (const entry of v[key]) { if (!entry || typeof entry !== 'object' || !('id' in entry)) throw new Error('Missing identity.'); id(entry.id); if (ids.has(entry.id)) throw new Error('Duplicate identity.'); ids.add(entry.id); }
  }
  const b = v as unknown as ObservationBundle;
  if (!b.artifacts.length || !b.observations.length) throw new Error('Evidence and observations are required.');
  const evidence = (key: unknown, roles?: string[]) => { id(key); const a = b.artifacts.find(a => a.id === key); if (!a || (roles && !roles.includes(a.role))) throw new Error('Missing or incompatible evidence artifact.'); };
  b.artifacts.forEach(a => { exactFields(a, ['id', 'role', 'reference']); enumeration(a.role, ['RAW', 'CALIBRATION', 'TRAJECTORY', 'ANNOTATION', 'DOCUMENTATION']); reference(a.reference); });
  exactFields(b.worldFrame, ['id', 'units', 'axes', 'definition', 'artifactId']); id(b.worldFrame.id); text(b.worldFrame.definition); evidence(b.worldFrame.artifactId);
  if (b.worldFrame.units !== 'm' || b.worldFrame.axes !== 'RIGHT_HANDED') throw new Error('V1 requires a declared right-handed metric frame.');
  exactFields(b.bodyFrame, ['id', 'definition', 'artifactId']); id(b.bodyFrame.id); text(b.bodyFrame.definition); evidence(b.bodyFrame.artifactId);
  exactFields(b.referenceClock, ['id', 'basis', 'definition']); id(b.referenceClock.id); text(b.referenceClock.definition); enumeration(b.referenceClock.basis, ['UNIX_UTC', 'TAI', 'GPS', 'MONOTONIC']);
  b.sensors.forEach(s => { exactFields(s, ['id', 'modality', 'frameId', 'definition', 'calibrationId']); id(s.frameId); text(s.definition); if (s.calibrationId !== null) id(s.calibrationId); enumeration(s.modality, ['CAMERA', 'LIDAR', 'RADAR', 'GNSS', 'IMU', 'WHEEL_ODOMETRY']); if (s.calibrationId !== null && !b.calibrations.some(c => c.id === s.calibrationId && c.sensorId === s.id)) throw new Error('Sensor calibration binding is missing.'); });
  b.clocks.forEach(c => {
    exactFields(c, ['id', 'basis', 'offsetToReferenceNs', 'uncertaintyNs', 'validFromNs', 'validUntilNs', 'artifactId']); enumeration(c.basis, ['UNIX_UTC', 'TAI', 'GPS', 'MONOTONIC', 'UNKNOWN']); evidence(c.artifactId, ['CALIBRATION', 'DOCUMENTATION']);
    nanos(c.validFromNs); nanos(c.validUntilNs); if (BigInt(c.validUntilNs) < BigInt(c.validFromNs)) throw new Error('Invalid clock validity interval.');
    if (c.offsetToReferenceNs !== null) nanos(c.offsetToReferenceNs, true); if (c.uncertaintyNs !== null) nanos(c.uncertaintyNs);
    if (c.basis === 'UNKNOWN' && (c.offsetToReferenceNs !== null || c.uncertaintyNs !== null)) throw new Error('Unknown clocks cannot imply calibrated alignment.');
  });
  b.calibrations.forEach(c => {
    exactFields(c, ['id', 'sensorId', 'version', 'artifactId', 'validFromReferenceNs', 'validUntilReferenceNs', 'sensorToBody', 'covariance', 'intrinsics']); id(c.sensorId); text(c.version); evidence(c.artifactId, ['CALIBRATION']);
    if (!b.sensors.some(s => s.id === c.sensorId)) throw new Error('Calibration sensor is missing.');
    nanos(c.validFromReferenceNs); nanos(c.validUntilReferenceNs); if (BigInt(c.validUntilReferenceNs) < BigInt(c.validFromReferenceNs)) throw new Error('Invalid calibration interval.'); transform(c.sensorToBody); covariance(c.covariance);
    if (c.intrinsics !== null) { exactFields(c.intrinsics, ['model', 'fx', 'fy', 'cx', 'cy']); if (c.intrinsics.model !== 'RECTIFIED_PINHOLE') throw new Error('Unsupported image model.'); vector([c.intrinsics.fx, c.intrinsics.fy, c.intrinsics.cx, c.intrinsics.cy], 4); if (c.intrinsics.fx <= 0 || c.intrinsics.fy <= 0) throw new Error('Focal length must be positive.'); }
  });
  b.poses.forEach(p => { exactFields(p, ['id', 'sessionId', 'referenceTimeNs', 'bodyToWorld', 'covariance', 'velocityWorldMps', 'artifactId']); id(p.sessionId); nanos(p.referenceTimeNs); transform(p.bodyToWorld); covariance(p.covariance); if (p.velocityWorldMps !== null) vector(p.velocityWorldMps, 3); evidence(p.artifactId, ['TRAJECTORY']); });
  b.observations.forEach(o => {
    exactFields(o, ['id', 'sessionId', 'sensorId', 'clockId', 'captureTimeNs', 'poseId', 'artifactId', 'selector', 'processing', 'measurement', 'association', 'gnss']); id(o.sessionId); nanos(o.captureTimeNs); text(o.selector); evidence(o.artifactId, ['RAW']);
    const sensor = b.sensors.find(s => s.id === o.sensorId); if (!sensor || !b.clocks.some(c => c.id === o.clockId)) throw new Error('Observation sensor or clock is missing.');
    if (o.poseId !== null && !b.poses.some(p => p.id === o.poseId && p.sessionId === o.sessionId)) throw new Error('Observation pose belongs to a different session or is missing.');
    exactFields(o.processing, ['method', 'version', 'artifactIds']); text(o.processing.method); text(o.processing.version); array(o.processing.artifactIds, 16); o.processing.artifactIds.forEach(a => evidence(a)); if (!o.processing.artifactIds.includes(o.artifactId)) throw new Error('Processing must reference the exact raw artifact.');
    if (o.measurement.kind === 'POINT3D') { exactFields(o.measurement, ['kind', 'pointM']); vector(o.measurement.pointM, 3); if (sensor.modality !== 'LIDAR') throw new Error('V1 only lifts LiDAR points into world coordinates.'); }
    else if (o.measurement.kind === 'PIXEL') { exactFields(o.measurement, ['kind', 'pixel']); vector(o.measurement.pixel, 2); if (sensor.modality !== 'CAMERA') throw new Error('Pixel observations require a camera.'); }
    else { exactFields(o.measurement, ['kind']); if (o.measurement.kind !== 'CONTEXT') throw new Error('Unsupported measurement.'); }
    exactFields(o.association, ['objectId', 'status', 'artifactId', 'probability']); enumeration(o.association.status, ['ASSUMED_STATIC', 'INDEPENDENT_STATIC_CHECK', 'UNKNOWN']);
    if (o.association.objectId !== null) id(o.association.objectId);
    if (o.association.artifactId !== null) evidence(o.association.artifactId, ['ANNOTATION']);
    if (o.association.status !== 'UNKNOWN' && (!o.association.objectId || !o.association.artifactId)) throw new Error('Associations require a declared object and annotation evidence.');
    if (o.association.probability !== null && (typeof o.association.probability !== 'number' || !Number.isFinite(o.association.probability) || o.association.probability < 0 || o.association.probability > 1)) throw new Error('Invalid association probability.');
    if (sensor.modality === 'GNSS') {
      exactFields(o.gnss, ['solutionStatus', 'correctionSource', 'correctionAgeSeconds']); enumeration(o.gnss.solutionStatus, ['RTK_FIXED', 'RTK_FLOAT', 'SINGLE', 'POST_PROCESSED', 'UNKNOWN']); if (o.gnss.correctionSource !== null) text(o.gnss.correctionSource);
      if (o.gnss.correctionAgeSeconds !== null && (typeof o.gnss.correctionAgeSeconds !== 'number' || !Number.isFinite(o.gnss.correctionAgeSeconds) || o.gnss.correctionAgeSeconds < 0)) throw new Error('Invalid correction age.');
    } else if (o.gnss !== null) throw new Error('GNSS status is not a perception modality.');
  });
  for (const key of ['artifacts', 'sensors', 'clocks', 'calibrations', 'poses', 'observations'] as const) b[key].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return b;
}
