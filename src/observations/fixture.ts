import { LocalEvidenceIntake, type LocalIntakeManifest } from '../data-os/local-intake';
import type { EvidenceReference } from '../spatial/contracts';
import { parseBundle, type ObservationBundle, type Transform } from './contracts';
import { ObservationReplayService, type ReplayRequest } from './service';
export const TEST_TIME = '2026-09-06T02:00:00.000Z';
export const identity = (translationM: [number, number, number] = [0, 0, 0]): Transform => ({ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translationM });
export function captureObservationArtifact(root: string, name: string, mediaType: string, bytes: Buffer, classification: 'SYNTHETIC_DEMONSTRATION' | 'PUBLIC_DATASET' = 'SYNTHETIC_DEMONSTRATION', at = TEST_TIME): EvidenceReference {
  const manifest: LocalIntakeManifest = { schema: 'payload.local-intake-request.v1', acquisitionId: `replay-${name}`, evidenceId: `replay-evidence-${name}`, purpose: 'OBSERVATION_REPLAY', mediaType, capturedAt: at,
    sourceRegistration: { registrationId: `replay-policy-${name}`, sourceId: `notation://observation-replay/${name}`, displayName: classification === 'PUBLIC_DATASET' ? 'Boreas bounded public research sample' : 'Synthetic observation replay fixture', sourceClass: classification,
      licenseId: classification === 'PUBLIC_DATASET' ? 'CC-BY-4.0' : 'local-declaration', policyVersion: '1.0.0', effectiveFrom: '2026-09-01T00:00:00.000Z', permittedPurposes: ['OBSERVATION_REPLAY'], allowedOperations: ['INGEST', 'DERIVE'], allowedAudiences: ['INTERNAL'], retention: { mode: 'INDEFINITE' } } };
  const { acquisition: a } = new LocalEvidenceIntake(root).capture(manifest, bytes, at);
  return { acquisition: { id: a.request.manifest.acquisitionId, digest: a.digest }, evidence: { id: a.request.manifest.evidenceId, contentDigest: a.request.contentDigest } };
}
export function syntheticBundle(root: string) {
  const raw = { lidarA: [-1, 0, 10], lidarB: [-3, 0, 10], cameraPixel: [320, 240], description: 'All values generated from one synthetic static target. Not independent measurements.' };
  const calibrationDescription = { lidarToBody: identity([1, 0, 0]), otherToBody: identity(), clockOffsetNs: '0', clockUncertaintyNs: '10000000', definition: 'Synthetic right-handed Cartesian axes; camera x right, y down, z forward. All units metres.' };
  const poses: ObservationBundle['poses'] = [
    { id: 'pose-A', sessionId: 'session-A', referenceTimeNs: '1000000000', bodyToWorld: identity(), covariance: null, velocityWorldMps: [20, 0, 0], artifactId: 'trajectory' },
    { id: 'pose-B', sessionId: 'session-B', referenceTimeNs: '2000000000', bodyToWorld: identity([2, 0, 0]), covariance: null, velocityWorldMps: [20, 0, 0], artifactId: 'trajectory' },
  ];
  const artifacts: ObservationBundle['artifacts'] = [
    { id: 'raw', role: 'RAW', reference: captureObservationArtifact(root, 'synthetic-raw', 'application/json', Buffer.from(JSON.stringify(raw))) },
    { id: 'calibration', role: 'CALIBRATION', reference: captureObservationArtifact(root, 'synthetic-calibration', 'application/json', Buffer.from(JSON.stringify(calibrationDescription))) },
    { id: 'trajectory', role: 'TRAJECTORY', reference: captureObservationArtifact(root, 'synthetic-trajectory', 'application/json', Buffer.from(JSON.stringify(poses))) },
    { id: 'annotation', role: 'ANNOTATION', reference: captureObservationArtifact(root, 'synthetic-annotation', 'application/json', Buffer.from(JSON.stringify({ target: [0, 0, 10], status: 'ASSUMED_STATIC', independentlyMeasured: false }))) },
  ];
  const sensors: ObservationBundle['sensors'] = ['LIDAR', 'CAMERA', 'GNSS', 'IMU'].map(modality => ({ id: modality.toLowerCase(), modality: modality as ObservationBundle['sensors'][number]['modality'], frameId: `${modality.toLowerCase()}-frame`, definition: 'Synthetic x right, y down, z forward; mounting transform declared separately.', calibrationId: `${modality.toLowerCase()}-mount` }));
  const calibrations: ObservationBundle['calibrations'] = sensors.map(s => ({ id: s.calibrationId!, sensorId: s.id, version: 'synthetic-1.0.0', artifactId: 'calibration', validFromReferenceNs: '0', validUntilReferenceNs: '3000000000', sensorToBody: s.modality === 'LIDAR' ? identity([1, 0, 0]) : identity(), covariance: null, intrinsics: s.modality === 'CAMERA' ? { model: 'RECTIFIED_PINHOLE', fx: 100, fy: 100, cx: 320, cy: 240 } : null }));
  const observation = (id: string, sensorId: string, measurement: ObservationBundle['observations'][number]['measurement'], second = false): ObservationBundle['observations'][number] => ({ id, sessionId: second ? 'session-B' : 'session-A', sensorId, clockId: 'sensor-clock', captureTimeNs: second ? '2000000000' : '1000000000', poseId: second ? 'pose-B' : 'pose-A', artifactId: 'raw', selector: `synthetic:${id}`, processing: { method: 'SYNTHETIC_FIXTURE_GENERATOR', version: '1.0.0', artifactIds: ['raw', 'calibration'] }, measurement,
    association: measurement.kind === 'CONTEXT' ? { objectId: null, status: 'UNKNOWN', artifactId: null, probability: null } : { objectId: 'target', status: 'ASSUMED_STATIC', artifactId: 'annotation', probability: null },
    gnss: sensorId === 'gnss' ? { solutionStatus: 'RTK_FIXED', correctionSource: null, correctionAgeSeconds: null } : null });
  const bundle = parseBundle({ schema: 'payload.observation-bundle.v1', id: 'synthetic-replay', classification: 'SYNTHETIC',
    worldFrame: { id: 'world', units: 'm', axes: 'RIGHT_HANDED', definition: calibrationDescription.definition, artifactId: 'calibration' },
    bodyFrame: { id: 'body', definition: calibrationDescription.definition, artifactId: 'calibration' },
    referenceClock: { id: 'fixture-reference-clock', basis: 'MONOTONIC', definition: 'Shared synthetic epoch; two explicitly timed collection sessions.' },
    artifacts, sensors, clocks: [{ id: 'sensor-clock', basis: 'MONOTONIC', offsetToReferenceNs: '0', uncertaintyNs: '10000000', validFromNs: '0', validUntilNs: '3000000000', artifactId: 'calibration' }], calibrations, poses,
    observations: [observation('lidar-A', 'lidar', { kind: 'POINT3D', pointM: [-1, 0, 10] }), observation('lidar-B', 'lidar', { kind: 'POINT3D', pointM: [-3, 0, 10] }, true), observation('camera-A', 'camera', { kind: 'PIXEL', pixel: [320, 240] }), observation('gnss-A', 'gnss', { kind: 'CONTEXT' }), observation('imu-A', 'imu', { kind: 'CONTEXT' })] });
  const source = captureObservationArtifact(root, 'synthetic-bundle', 'application/json', Buffer.from(JSON.stringify(bundle, null, 2)));
  const request: ReplayRequest = { schema: 'payload.observation-replay-request.v1', requestId: 'synthetic-replay-1', purpose: 'OBSERVATION_REPLAY', source,
    pairs: [{ id: 'cross-session', leftId: 'lidar-A', rightId: 'lidar-B' }, { id: 'cross-sensor', leftId: 'lidar-A', rightId: 'camera-A' }] };
  return { bundle, request };
}
export function syntheticReplay(root: string) {
  const fixture = syntheticBundle(root);
  return { ...fixture, analysis: new ObservationReplayService(root, () => TEST_TIME).submit(fixture.request) };
}
