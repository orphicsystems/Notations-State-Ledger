import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseBundle, replayDigest } from './contracts';
import { apply, inverseApply, replay } from './replay';
import { identity, syntheticBundle, TEST_TIME } from './fixture';
import { ObservationReplayService } from './service';
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'observation-replay-')); roots.push(root); return { root, ...syntheticBundle(root) }; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('composes lever arm and pose, compares sessions and projects a LiDAR point into a camera', () => {
  const { bundle, request } = fixture(), result = replay(bundle, request.pairs);
  expect(result.readings.find(r => r.id === 'lidar-A')?.pointWorldM).toEqual([0, 0, 10]);
  expect(result.comparisons.map(c => c.residual)).toEqual([{ units: 'px', components: [0, 0], magnitude: 0 }, { units: 'm', components: [0, 0, 0], magnitude: 0 }]);
  expect(result.fieldAccuracyEstablished).toBe(false);
  expect(result.readings.find(r => r.id === 'gnss-A')?.gnss?.solutionStatus).toBe('RTK_FIXED');
  expect(result.readings.find(r => r.id === 'lidar-A')?.uncertainty.timingSensitivityM).toBe(0.2);
  expect(result.readings.every(r => r.uncertainty.propagatedCovariance === null)).toBe(true);
});
it('exposes a mounting error as a metric and pixel residual without fitting it away', () => {
  const { bundle, request } = fixture(); bundle.calibrations.find(c => c.sensorId === 'camera')!.sensorToBody.translationM[0] = 1;
  expect(replay(bundle, request.pairs).comparisons.find(c => c.id === 'cross-sensor')?.residual?.magnitude).toBe(10);
  bundle.observations.find(o => o.id === 'lidar-B')!.measurement = { kind: 'POINT3D', pointM: [-2.8, 0, 10] };
  expect(replay(bundle, request.pairs).comparisons.find(c => c.id === 'cross-session')?.residual?.magnitude).toBeCloseTo(0.2);
});
it('refuses stale poses, unknown clocks, expired calibration and unresolved associations', () => {
  const { bundle, request } = fixture(); bundle.observations.find(o => o.id === 'lidar-A')!.captureTimeNs = '1010000000';
  expect(replay(bundle, request.pairs).readings.find(r => r.id === 'lidar-A')?.reasons).toContain('POSE_NOT_AT_CAPTURE_TIME');
  bundle.clocks[0].offsetToReferenceNs = null;
  expect(replay(bundle, request.pairs).comparisons.every(c => c.residual === null)).toBe(true);
  const fresh = fixture(); fresh.bundle.calibrations[0].validUntilReferenceNs = '1';
  expect(replay(fresh.bundle, fresh.request.pairs).readings.some(r => r.reasons.includes('MOUNT_CALIBRATION_OUTSIDE_VALIDITY'))).toBe(true);
  fresh.bundle.observations.forEach(o => { o.association.status = 'UNKNOWN'; });
  expect(replay(fresh.bundle, fresh.request.pairs).comparisons.every(c => c.reasons.includes('STATIC_CORRESPONDENCE_UNRESOLVED'))).toBe(true);
});
it('keeps exact nanoseconds above Number precision and applies only declared clock offsets', () => {
  const { bundle, request } = fixture();
  bundle.clocks[0].validUntilNs = '1800000000000000010'; bundle.clocks[0].offsetToReferenceNs = '7';
  bundle.calibrations.forEach(c => { c.validUntilReferenceNs = '1800000000000000020'; });
  bundle.observations.forEach(o => { o.captureTimeNs = '1800000000000000001'; });
  bundle.poses.forEach(p => { p.referenceTimeNs = '1800000000000000008'; });
  expect(replay(bundle, request.pairs).readings.every(r => r.referenceTimeNs === '1800000000000000008' && r.alignment !== 'UNRESOLVED')).toBe(true);
});
it('preserves residual magnitudes under a common rotation and translation, and record reordering', () => {
  const { bundle, request } = fixture(), baseline = replay(bundle, request.pairs);
  const changed = structuredClone(bundle); changed.observations.reverse(); changed.poses.reverse(); changed.artifacts.reverse();
  expect(replay(changed, [...request.pairs].reverse())).toEqual(baseline);
  const t = { rotation: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translationM: [20, 30, 40] as [number, number, number] };
  changed.poses.forEach(p => { p.bodyToWorld = { rotation: t.rotation, translationM: apply(t, p.bodyToWorld.translationM) }; });
  expect(replay(changed, request.pairs).comparisons.map(c => c.residual?.magnitude)).toEqual([0, 0]);
  const p: [number, number, number] = [3, 4, 5]; expect(inverseApply(t, apply(t, p))).toEqual(p);
  expect(replayDigest(bundle)).not.toBe(replayDigest(changed));
});
it('rejects reflections, invalid covariance, unsafe references, unsupported modalities and extra fields', () => {
  const { bundle } = fixture();
  expect(() => parseBundle({ ...bundle, communicationsAsPositioning: true })).toThrow();
  const reflected = structuredClone(bundle); reflected.poses[0].bodyToWorld.rotation[0][0] = -1; expect(() => parseBundle(reflected)).toThrow('Reflections');
  bundle.poses[0].covariance = { convention: 'RIGHT_LOCAL_SE3_TX_TY_TZ_RX_RY_RZ', matrix: Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => i === j ? 1 : 0)) };
  expect(parseBundle(bundle).poses[0].covariance).not.toBeNull(); bundle.poses[0].covariance.matrix[0][0] = -1; expect(() => parseBundle(bundle)).toThrow('positive semidefinite');
  const bad = fixture(); bad.bundle.sensors[0].modality = 'RTK' as never; expect(() => parseBundle(bad.bundle)).toThrow('vocabulary');
  bad.bundle.sensors[0].modality = 'CAMERA'; bad.bundle.artifacts[0].reference.acquisition.id = '../path'; expect(() => parseBundle(bad.bundle)).toThrow();
});
it('preserves source and method through saved inspection without replaying and detects corruption', () => {
  const { root, request } = fixture(), compute = vi.fn(replay), service = new ObservationReplayService(root, () => TEST_TIME, compute);
  const first = service.submit(request); expect(service.submit(request).status).toBe('EXISTING'); expect(compute).toHaveBeenCalledTimes(1);
  const loaded = new ObservationReplayService(root, () => '2030-01-01T00:00:00.000Z', () => { throw new Error('Must not compute'); }).inspect(request.requestId);
  expect(loaded?.receipt).toEqual(first.receipt); expect(loaded?.projection.sourceKind).toBe('LOCAL_ANALYSIS');
  const dir = join(root, 'observation-replay', 'receipts'), path = join(dir, readdirSync(dir)[0]);
  const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.result.fieldAccuracyEstablished = true; writeFileSync(path, JSON.stringify(receipt));
  expect(() => service.inspect(request.requestId)).toThrow('failed verification');
});
it('refuses unauthorized source use, conflicting identity and replay of interrupted execution', () => {
  const { root, request } = fixture(), service = new ObservationReplayService(root, () => TEST_TIME);
  expect(() => service.submit({ ...request, purpose: 'OTHER' })).toThrow('does not allow');
  service.submit(request); expect(() => service.submit({ ...request, pairs: [] })).toThrow('different inputs');
  const fresh = fixture(), failing = new ObservationReplayService(fresh.root, () => TEST_TIME, () => { throw new Error('Interrupted'); });
  expect(() => failing.submit(fresh.request)).toThrow('Interrupted'); expect(() => failing.submit(fresh.request)).toThrow('reserved');
  expect(identity().translationM).toEqual([0, 0, 0]);
});
