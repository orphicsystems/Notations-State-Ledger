import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { preserveFixture } from '../spatial/fixture';
import { digest } from '../spatial/contracts';
import { measureAccess, type AccessMetric } from '../spatial/distance';
import { apply } from '../observations/replay';
import { registerRigid, parseRegistration, type RegistrationInput } from './rigid';
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'registration-distance-')); roots.push(root); const fixture = preserveFixture(root);
  const rotation = [[Math.cos(0.2), -Math.sin(0.2), 0], [Math.sin(0.2), Math.cos(0.2), 0], [0, 0, 1]];
  const truth = { rotation, translationM: [2, 3, 0.5] as [number, number, number] };
  const points: [number, number, number][] = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 2], [2, 2, 2]];
  const fit = points.map((p, i) => ({ id: `C-${i}`, sourceM: p, observedReferenceM: apply(truth, p), evidence: fixture.baseline.layout }));
  const input: RegistrationInput = { schema: 'payload.rigid-registration.v1', sourceFrameId: 'scan', referenceFrameId: fixture.layout.frame.id, units: 'm', classification: 'SYNTHETIC', sourceTreatment: 'FIXED_CONDITIONAL', initial: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translationM: [0, 0, 0] }, fit,
    heldOut: [{ id: 'H-1', sourceM: [1, 1, 1], observedReferenceM: apply(truth, [1, 1, 1]), evidence: fixture.baseline.layout }],
    noise: { convention: 'REFERENCE_XYZ_RESIDUAL_M2', controlOrder: fit.map(c => c.id), covariance: Array.from({ length: 15 }, (_, i) => Array.from({ length: 15 }, (_, j) => i === j ? 0.0001 : 0)), evidence: fixture.baseline.layout }, heldOutIndependence: 'SYNTHETIC' };
  const metric: AccessMetric = { schema: 'payload.access-metric.v1', layoutDigest: digest(fixture.layout), frameId: fixture.layout.frame.id, units: 'm', classification: 'SYNTHETIC', evidence: fixture.baseline.layout,
    anchors: fixture.layout.spaces.map((s, i) => ({ spaceId: s.id, pointM: [2 + 5 * i, 2, 0] })), passages: fixture.layout.passages.map((p, i) => ({ passageId: p.id, lengthM: [7, 9, 8, 10][i] })) };
  return { ...fixture, input, truth, metric };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('recovers rigid translation and rotation and evaluates held-out controls separately', () => {
  const { input, truth } = setup(), result = registerRigid(input);
  expect(result.status).toBe('LOCAL_STATIONARY'); expect(result.fit.rmsM!).toBeLessThan(1e-9); expect(result.heldOut.rmsM!).toBeLessThan(1e-9);
  result.transform!.translationM.forEach((x, i) => expect(x).toBeCloseTo(truth.translationM[i], 9));
  expect(result.covariance?.matrix).toHaveLength(6); expect(result.fieldAccuracyEstablished).toBe(false);
  input.heldOut[0].observedReferenceM[0] += 0.1;
  const changed = registerRigid(input); expect(changed.transform).toEqual(result.transform); expect(changed.fit).toEqual(result.fit); expect(changed.heldOut.rmsM).toBeCloseTo(0.1);
});
it('rejects collinear geometry instead of reporting a precise unconstrained rotation', () => {
  const { input } = setup(); input.fit.forEach((c, i) => { c.sourceM = [i, 0, 0]; c.observedReferenceM = [i + 1, 0, 0]; });
  const r = registerRigid(input); expect(r.status).toBe('UNOBSERVABLE_OR_ILL_CONDITIONED'); expect(r.transform).toBeNull(); expect(r.covariance).toBeNull();
});
it('preserves covariance ordering and correlations; shared errors are not independent votes', () => {
  const { input } = setup(), baseline = registerRigid(input);
  const reordered = structuredClone(input); reordered.fit.reverse(); reordered.noise.controlOrder.reverse();
  const permutation = reordered.noise.controlOrder.flatMap(id => [0, 1, 2].map(k => input.noise.controlOrder.indexOf(id) * 3 + k));
  reordered.noise.covariance = permutation.map(i => permutation.map(j => input.noise.covariance[i][j]));
  expect(registerRigid(reordered)).toEqual(baseline);
  input.noise.covariance = input.noise.covariance.map((row, i) => row.map((x, j) => x + (i % 3 === j % 3 ? 0.0025 : 0)));
  const shared = registerRigid(input);
  expect(shared.status).toBe('LOCAL_STATIONARY');
  for (let i = 0; i < 3; i++) expect(shared.covariance!.matrix[i][i] - baseline.covariance!.matrix[i][i]).toBeCloseTo(0.0025, 8);
});
it('rejects invalid covariance, duplicate held-out identities and unsupported unit models', () => {
  const { input } = setup(); input.noise.covariance[0][0] = -1; expect(() => parseRegistration(input)).toThrow();
  const next = setup().input; next.heldOut[0].id = next.fit[0].id; expect(() => registerRigid(next)).toThrow('disjoint');
  expect(() => parseRegistration({ ...setup().input, units: 'mm' })).toThrow('Unsupported');
});
it('distinguishes a 15 m chord from a 24 m permitted route and preserves bridge-closure effects', () => {
  const { layout, baseline, scenario, metric } = setup(), original = JSON.stringify(layout);
  const a = measureAccess(layout, baseline, metric, 'S-1', 'S-4'), b = measureAccess(layout, scenario, metric, 'S-1', 'S-4');
  expect(a.euclidean.distanceM).toBe(15); expect(a.network.confirmed?.lengthM).toBe(24); expect(a.network.confirmed?.passageIds).toEqual(['P-01', 'P-07', 'P-08']);
  expect(b.euclidean.distanceM).toBe(15); expect(b.network.status).toBe('DISCONNECTED'); expect(JSON.stringify(layout)).toBe(original);
  const unknown = measureAccess(layout, baseline, metric, 'S-1', 'S-5'); expect(unknown.network.confirmed).toBeNull(); expect(unknown.network.possible?.lengthM).toBe(34);
});
it('refuses unknown or impossible walking lengths and keeps route choice deterministic', () => {
  const { layout, baseline, metric } = setup(), before = measureAccess(layout, baseline, metric, 'S-1', 'S-4');
  metric.anchors.reverse(); metric.passages.reverse(); expect(measureAccess(layout, baseline, metric, 'S-1', 'S-4')).toEqual(before);
  metric.passages[0].lengthM = null; expect(measureAccess(layout, baseline, metric, 'S-1', 'S-4').network.status).toBe('LENGTH_UNRESOLVED');
  metric.passages[0].lengthM = 1; expect(() => measureAccess(layout, baseline, metric, 'S-1', 'S-4')).toThrow('shorter than');
});

it('gives a less precise control less influence under the declared noise model', () => {
  const { input, truth } = setup(); input.fit[0].observedReferenceM[0] += 0.4;
  const ordinary = registerRigid(input);
  for (let i = 0; i < 3; i++) input.noise.covariance[i][i] = 1;
  const weighted = registerRigid(input);
  expect(weighted.status).toBe('LOCAL_STATIONARY'); expect(ordinary.status).toBe('LOCAL_STATIONARY');
  const error = (t: NonNullable<typeof weighted.transform>) => Math.hypot(...t.translationM.map((x, i) => x - truth.translationM[i]));
  expect(error(weighted.transform!)).toBeLessThan(error(ordinary.transform!) / 10);
});
it('chooses weighted route length rather than hop count and respects one-way access', () => {
  const { layout, baseline, metric } = setup();
  layout.passages.push({ ...layout.passages[0], id: 'P-10', from: 'S-1', to: 'S-4' });
  metric.passages.push({ passageId: 'P-10', lengthM: 30 }); metric.layoutDigest = digest(layout);
  expect(measureAccess(layout, baseline, metric, 'S-1', 'S-4').network.confirmed?.lengthM).toBe(24);
  const next = setup(); next.layout.passages[0].direction = 'FROM_TO'; next.metric.layoutDigest = digest(next.layout);
  expect(measureAccess(next.layout, next.baseline, next.metric, 'S-4', 'S-1').network.status).toBe('DISCONNECTED');
});
