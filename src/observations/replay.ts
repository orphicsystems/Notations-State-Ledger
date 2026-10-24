import { parseBundle, replayDigest, type ObservationBundle, type Transform, type Vec3 } from './contracts';
import { exactFields } from '../data-os/local-record';
import { id } from '../spatial/contracts';
export const REPLAY_METHOD = { id: 'explicit-pose-observation-replay', version: '1.0.0', transform: 'COLUMN_VECTOR_WORLD_FROM_BODY_FROM_SENSOR', timing: 'EXACT_DECLARED_CAPTURE_POSE_ONLY', uncertainty: 'PRESERVED_NOT_FUSED', comparison: 'DECLARED_STATIC_CORRESPONDENCE' } as const;
export type ReplayPair = { id: string; leftId: string; rightId: string };
export function apply(t: Transform, point: Vec3): Vec3 {
  return t.rotation.map((row, i) => row.reduce((sum, x, k) => sum + x * point[k], t.translationM[i])) as Vec3;
}
export function inverseApply(t: Transform, point: Vec3): Vec3 {
  return [0, 1, 2].map(i => t.rotation.reduce((sum, row, k) => sum + row[i] * (point[k] - t.translationM[k]), 0)) as Vec3;
}
export function parsePairs(input: unknown): ReplayPair[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error('Replay accepts at most 64 explicit comparisons.');
  const ids = new Set<string>();
  const pairs = input.map(p => { exactFields(p, ['id', 'leftId', 'rightId']); id(p.id); id(p.leftId); id(p.rightId); if (p.leftId === p.rightId || ids.has(p.id)) throw new Error('Invalid comparison identity.'); ids.add(p.id); return { id: p.id, leftId: p.leftId, rightId: p.rightId }; });
  return pairs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function replay(input: ObservationBundle, requestedPairs: ReplayPair[] = []) {
  const bundle = parseBundle(input), pairs = parsePairs(requestedPairs);
  const readings = bundle.observations.map(o => {
    const sensor = bundle.sensors.find(s => s.id === o.sensorId)!;
    const calibration = bundle.calibrations.find(c => c.id === sensor.calibrationId)!;
    const clock = bundle.clocks.find(c => c.id === o.clockId)!;
    const pose = bundle.poses.find(p => p.id === o.poseId);
    const capture = BigInt(o.captureTimeNs);
    const referenceTime = clock.offsetToReferenceNs === null ? null : capture + BigInt(clock.offsetToReferenceNs);
    const reasons: string[] = [];
    if (capture < BigInt(clock.validFromNs) || capture > BigInt(clock.validUntilNs)) reasons.push('CLOCK_CALIBRATION_OUTSIDE_VALIDITY');
    if (referenceTime === null || referenceTime < BigInt(0)) reasons.push('CLOCK_ALIGNMENT_UNKNOWN');
    if (calibration && referenceTime !== null && (referenceTime < BigInt(calibration.validFromReferenceNs) || referenceTime > BigInt(calibration.validUntilReferenceNs))) reasons.push('MOUNT_CALIBRATION_OUTSIDE_VALIDITY');
    if (!calibration) reasons.push('MOUNT_CALIBRATION_UNKNOWN');
    if (!pose) reasons.push('POSE_UNAVAILABLE');
    else if (referenceTime === null || BigInt(pose.referenceTimeNs) !== referenceTime) reasons.push('POSE_NOT_AT_CAPTURE_TIME');
    const aligned = reasons.length === 0;
    const pointWorldM = aligned && o.measurement.kind === 'POINT3D' ? apply(pose!.bodyToWorld, apply(calibration.sensorToBody, o.measurement.pointM)) : null;
    const unknowns = [clock.uncertaintyNs === null ? 'CLOCK_UNCERTAINTY_UNKNOWN' : null, pose?.covariance == null ? 'POSE_COVARIANCE_UNKNOWN' : null, calibration?.covariance == null ? 'MOUNT_COVARIANCE_UNKNOWN' : null, 'MEASUREMENT_COVARIANCE_NOT_SUPPLIED', 'CROSS_CORRELATIONS_NOT_MODELED'].filter((s): s is string => s !== null);
    const timingSensitivityM = pose?.velocityWorldMps && clock.uncertaintyNs !== null ? Math.hypot(...pose.velocityWorldMps) * Number(BigInt(clock.uncertaintyNs)) / 1e9 : null;
    return { id: o.id, sessionId: o.sessionId, sensorId: o.sensorId, modality: sensor.modality, rawArtifactId: o.artifactId, selector: o.selector,
      calibrationId: calibration?.id ?? null, calibrationVersion: calibration?.version ?? null, poseId: o.poseId, clockId: o.clockId,
      referenceTimeNs: referenceTime?.toString() ?? null, alignment: aligned ? 'DECLARED_POSE_AT_CAPTURE' : 'UNRESOLVED', reasons,
      pointWorldM, gnss: o.gnss, association: o.association,
      uncertainty: { unknowns, poseCovariance: pose?.covariance ?? null, calibrationCovariance: calibration?.covariance ?? null, clockUncertaintyNs: clock.uncertaintyNs, timingSensitivityM, timingInterpretation: 'TRANSLATION_ONLY_SENSITIVITY_NOT_ERROR_BOUND', propagatedCovariance: null } };
  });
  const comparisons = pairs.map(pair => {
    const a = bundle.observations.find(o => o.id === pair.leftId), b = bundle.observations.find(o => o.id === pair.rightId);
    if (!a || !b) throw new Error('Comparison references a missing observation.');
    const left = readings.find(r => r.id === a.id)!, right = readings.find(r => r.id === b.id)!;
    const reasons: string[] = [];
    if (a.association.status === 'UNKNOWN' || b.association.status === 'UNKNOWN' || !a.association.objectId || a.association.objectId !== b.association.objectId) reasons.push('STATIC_CORRESPONDENCE_UNRESOLVED');
    if (left.alignment === 'UNRESOLVED' || right.alignment === 'UNRESOLVED') reasons.push('CAPTURE_POSE_ALIGNMENT_UNRESOLVED');
    let residual: { units: 'm' | 'px'; components: number[]; magnitude: number } | null = null;
    if (!reasons.length && left.pointWorldM && right.pointWorldM) {
      const components = right.pointWorldM.map((x, i) => x - left.pointWorldM![i]);
      residual = { units: 'm', components, magnitude: Math.hypot(...components) };
    } else if (!reasons.length) {
      const point = left.pointWorldM ?? right.pointWorldM;
      const image = left.pointWorldM ? b : a;
      const sensor = bundle.sensors.find(s => s.id === image.sensorId)!;
      const calibration = bundle.calibrations.find(c => c.id === sensor.calibrationId)!;
      const pose = bundle.poses.find(p => p.id === image.poseId)!;
      if (!point || image.measurement.kind !== 'PIXEL' || !calibration.intrinsics) reasons.push('MEASUREMENT_PAIR_UNSUPPORTED');
      else {
        const camera = inverseApply(calibration.sensorToBody, inverseApply(pose.bodyToWorld, point));
        if (camera[2] <= 1e-6) reasons.push('POINT_NOT_IN_FRONT_OF_CAMERA');
        else {
          const k = calibration.intrinsics;
          const components = [image.measurement.pixel[0] - (k.fx * camera[0] / camera[2] + k.cx), image.measurement.pixel[1] - (k.fy * camera[1] / camera[2] + k.cy)];
          residual = { units: 'px', components, magnitude: Math.hypot(...components) };
        }
      }
    }
    return { ...pair, objectId: a.association.objectId, crossSession: a.sessionId !== b.sessionId,
      status: residual ? 'DESCRIPTIVE_RESIDUAL' : 'UNRESOLVED', reasons, residual,
      interpretation: 'CONDITIONAL_ON_DECLARED_STATIC_ASSOCIATION_AND_CALIBRATION', calibratedAccuracyEstablished: false };
  });
  const payload = { schema: 'payload.observation-replay-result.v1', bundleDigest: replayDigest(bundle), classification: bundle.classification,
    method: REPLAY_METHOD, parameters: { pairs }, frame: bundle.worldFrame, referenceClock: bundle.referenceClock,
    readings, comparisons, coverage: { observations: readings.length, aligned: readings.filter(r => r.alignment !== 'UNRESOLVED').length, compared: comparisons.filter(c => c.residual !== null).length },
    fieldAccuracyEstablished: false, physicalActionAuthorized: false };
  return { ...payload, digest: replayDigest(payload) };
}
export type ReplayResult = ReturnType<typeof replay>;
