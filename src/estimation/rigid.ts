import { encodeLocalRecord, exactFields } from '../data-os/local-record';
import { id, reference, type EvidenceReference } from '../spatial/contracts';
import { apply } from '../observations/replay';
import { replayDigest, transform, type Transform, type Vec3 } from '../observations/contracts';

export interface Control { id: string; sourceM: Vec3; observedReferenceM: Vec3; evidence: EvidenceReference }
export interface RegistrationInput {
  schema: 'payload.rigid-registration.v1'; sourceFrameId: string; referenceFrameId: string; units: 'm';
  classification: 'SYNTHETIC' | 'RECORDED'; sourceTreatment: 'FIXED_CONDITIONAL'; initial: Transform;
  fit: Control[]; heldOut: Control[];
  noise: { convention: 'REFERENCE_XYZ_RESIDUAL_M2'; controlOrder: string[]; covariance: number[][]; evidence: EvidenceReference };
  heldOutIndependence: 'SYNTHETIC' | 'OPERATOR_DECLARED' | 'UNKNOWN';
}
export const REGISTRATION_METHOD = { id: 'dense-weighted-rigid-registration', version: '1.0.0', solver: 'GAUSS_NEWTON_BACKTRACKING_WHITENED_REORTHOGONALIZED_QR', maxIterations: 40, rankTolerance: 1e-8, translationStepToleranceM: 1e-8, rotationStepToleranceRad: 1e-8, loss: 'SQUARED', covariance: 'LOCAL_GAUSSIAN_FIXED_SOURCE_ABSOLUTE_NOISE', perturbation: 'REFERENCE_TRANSLATION_XYZ_AND_LEFT_ROTATION_XYZ' } as const;
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const norm = (a: number[]) => Math.hypot(...a);
function vector(v: unknown) { if (!Array.isArray(v) || v.length !== 3 || v.some(x => typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 10000)) throw new Error('Controls require finite local metre coordinates within 10 km.'); }
export function parseRegistration(input: unknown): RegistrationInput {
  const v: unknown = JSON.parse(encodeLocalRecord(input, 512 * 1024).toString('utf8'));
  exactFields(v, ['schema', 'sourceFrameId', 'referenceFrameId', 'units', 'classification', 'sourceTreatment', 'initial', 'fit', 'heldOut', 'noise', 'heldOutIndependence']);
  if (v.schema !== 'payload.rigid-registration.v1' || v.units !== 'm' || v.sourceTreatment !== 'FIXED_CONDITIONAL' || !['SYNTHETIC', 'RECORDED'].includes(v.classification as string) || !['SYNTHETIC', 'OPERATOR_DECLARED', 'UNKNOWN'].includes(v.heldOutIndependence as string)) throw new Error('Unsupported registration contract.');
  id(v.sourceFrameId); id(v.referenceFrameId); if (v.sourceFrameId === v.referenceFrameId) throw new Error('Registration requires distinct frame identities.'); transform(v.initial);
  const ids = new Set<string>();
  for (const key of ['fit', 'heldOut'] as const) {
    if (!Array.isArray(v[key]) || v[key].length > 32 || (key === 'fit' && v[key].length < 3)) throw new Error('Use 3–32 fit controls and at most 32 held-out controls.');
    v[key].forEach(c => { exactFields(c, ['id', 'sourceM', 'observedReferenceM', 'evidence']); id(c.id); if (ids.has(c.id)) throw new Error('Fit and held-out control identities must be disjoint.'); ids.add(c.id); vector(c.sourceM); vector(c.observedReferenceM); reference(c.evidence); });
  }
  const r = v as unknown as RegistrationInput;
  exactFields(v.noise, ['convention', 'controlOrder', 'covariance', 'evidence']); reference(v.noise.evidence);
  if (v.noise.convention !== 'REFERENCE_XYZ_RESIDUAL_M2' || !Array.isArray(v.noise.controlOrder) || v.noise.controlOrder.length !== r.fit.length || new Set(v.noise.controlOrder).size !== r.fit.length || v.noise.controlOrder.some(key => !r.fit.some(c => c.id === key))) throw new Error('Covariance requires an explicit complete control ordering.');
  const n = r.fit.length * 3;
  if (!Array.isArray(v.noise.covariance) || v.noise.covariance.length !== n || v.noise.covariance.some(row => !Array.isArray(row) || row.length !== n || row.some(x => typeof x !== 'number' || !Number.isFinite(x)))) throw new Error('Covariance must be a full finite 3N-by-3N matrix.');
  // Canonicalize both the control records and covariance axes together.
  r.fit.sort((a, b) => a.id < b.id ? -1 : 1); r.heldOut.sort((a, b) => a.id < b.id ? -1 : 1);
  const order = r.fit.flatMap(c => [0, 1, 2].map(axis => r.noise.controlOrder.indexOf(c.id) * 3 + axis));
  r.noise.covariance = order.map(i => order.map(j => r.noise.covariance[i][j])); r.noise.controlOrder = r.fit.map(c => c.id);
  cholesky(r.noise.covariance);
  return r;
}
function cholesky(a: number[][]) {
  const n = a.length, scale = Math.max(...a.map((row, i) => Math.abs(row[i]))), l = a.map(() => Array(n).fill(0) as number[]);
  if (!(scale > 0)) throw new Error('Residual covariance must be positive definite.');
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (Math.abs(a[i][j] - a[j][i]) > scale * 1e-12) throw new Error('Residual covariance must be symmetric.');
    const value = a[i][j] - l[i].slice(0, j).reduce((s, x, k) => s + x * l[j][k], 0);
    if (!Number.isFinite(value)) throw new Error('Covariance factorization exceeded finite numerical range.');
    if (i === j) { if (value <= scale * 1e-12) throw new Error('Residual covariance is singular, indefinite or too ill-conditioned.'); l[i][j] = Math.sqrt(value); }
    else l[i][j] = value / l[j][j];
  }
  return l;
}
function lowerSolve(l: number[][], b: number[]) { const x: number[] = []; for (let i = 0; i < b.length; i++) x.push((b[i] - l[i].slice(0, i).reduce((sum, a, j) => sum + a * x[j], 0)) / l[i][i]); return x; }
function upperSolve(r: number[][], b: number[]) { const x = Array(b.length).fill(0) as number[]; for (let i = b.length - 1; i >= 0; i--) x[i] = (b[i] - r[i].slice(i + 1).reduce((s, a, j) => s + a * x[j + i + 1], 0)) / r[i][i]; return x; }
function qr(j: number[][], residual: number[]) {
  const columns = Array.from({ length: 6 }, (_, k) => j.map(row => row[k])), scales = columns.map(norm);
  if (scales.some(s => !Number.isFinite(s) || s === 0)) return null;
  const q: number[][] = [], r = Array.from({ length: 6 }, () => Array(6).fill(0) as number[]);
  for (let k = 0; k < 6; k++) {
    const column = columns[k].map(x => x / scales[k]);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < k; i++) { const amount = dot(q[i], column); r[i][k] += amount; column.forEach((_, row) => { column[row] -= amount * q[i][row]; }); }
    r[k][k] = norm(column); if (r[k][k] < REGISTRATION_METHOD.rankTolerance) return null; q.push(column.map(x => x / r[k][k]));
  }
  const delta = upperSolve(r, q.map(column => -dot(column, residual))).map((x, i) => x / scales[i]);
  const inverseColumns = Array.from({ length: 6 }, (_, k) => upperSolve(r, Array.from({ length: 6 }, (_, i) => i === k ? 1 : 0)));
  const inverse = Array.from({ length: 6 }, (_, i) => inverseColumns.map(column => column[i] / scales[i]));
  return { delta, covariance: inverse.map(row => inverse.map(other => dot(row, other))), scaledPivots: r.map((row, i) => row[i]) };
}
function retract(t: Transform, delta: number[], scale: number): Transform {
  const w = delta.slice(3).map(x => x * scale), angle = norm(w), [x, y, z] = w;
  const skew = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
  const a = angle < 1e-8 ? 1 - angle * angle / 6 : Math.sin(angle) / angle;
  const b = angle < 1e-8 ? 0.5 - angle * angle / 24 : (1 - Math.cos(angle)) / (angle * angle);
  const e = skew.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) + a * v + b * dot(row, skew.map(r => r[j]))));
  return { rotation: e.map(row => [0, 1, 2].map(j => dot(row, t.rotation.map(r => r[j])))), translationM: t.translationM.map((x, i) => x + scale * delta[i]) as Vec3 };
}
function residuals(controls: Control[], t: Transform) { return controls.map(c => { const predicted = apply(t, c.sourceM), vectorM = predicted.map((x, i) => x - c.observedReferenceM[i]); return { id: c.id, vectorM, distanceM: norm(vectorM) }; }); }
export function registerRigid(input: RegistrationInput) {
  const r = parseRegistration(input), l = cholesky(r.noise.covariance);
  let estimate = r.initial, status = 'ITERATION_LIMIT', iterations = 0;
  const evaluate = (t: Transform) => { const residual = lowerSolve(l, residuals(r.fit, t).flatMap(row => row.vectorM)); return { residual, cost: dot(residual, residual) }; };
  const linearize = (t: Transform) => {
    const raw = r.fit.flatMap(c => { const [x, y, z] = apply({ rotation: t.rotation, translationM: [0, 0, 0] }, c.sourceM); return [[1, 0, 0, 0, z, -y], [0, 1, 0, -z, 0, x], [0, 0, 1, y, -x, 0]]; });
    const columns = Array.from({ length: 6 }, (_, i) => lowerSolve(l, raw.map(row => row[i])));
    return qr(raw.map((_, i) => columns.map(column => column[i])), evaluate(t).residual);
  };
  for (; iterations < REGISTRATION_METHOD.maxIterations; iterations++) {
    const system = linearize(estimate); if (!system) { status = 'UNOBSERVABLE_OR_ILL_CONDITIONED'; break; }
    if (norm(system.delta.slice(0, 3)) <= REGISTRATION_METHOD.translationStepToleranceM && norm(system.delta.slice(3)) <= REGISTRATION_METHOD.rotationStepToleranceRad) { status = 'LOCAL_STATIONARY'; break; }
    const cost = evaluate(estimate).cost; let accepted = false;
    for (let backtrack = 0; backtrack < 20; backtrack++) { const trial = retract(estimate, system.delta, 2 ** -backtrack); if (evaluate(trial).cost < cost) { estimate = trial; accepted = true; break; } }
    if (!accepted) { status = 'NO_DESCENT'; break; }
  }
  const system = linearize(estimate), usable = status === 'LOCAL_STATIONARY' && system !== null;
  if (usable) transform(estimate);
  const fitResiduals = usable ? residuals(r.fit, estimate) : [], heldOutResiduals = usable ? residuals(r.heldOut, estimate) : [];
  const rms = (rows: typeof fitResiduals) => rows.length ? Math.sqrt(rows.reduce((sum, row) => sum + row.distanceM ** 2, 0) / rows.length) : null;
  const payload = { schema: 'payload.rigid-registration-result.v1', inputDigest: replayDigest(r), method: REGISTRATION_METHOD, status, iterations,
    sourceFrameId: r.sourceFrameId, referenceFrameId: r.referenceFrameId, units: r.units, classification: r.classification,
    transform: usable ? estimate : null, covariance: usable ? { convention: REGISTRATION_METHOD.perturbation, units: 'm_and_rad', matrix: system!.covariance, interpretation: 'LOCAL_APPROXIMATION_CONDITIONAL_ON_SUPPLIED_ABSOLUTE_COVARIANCE' } : null,
    fit: { residuals: fitResiduals, rmsM: rms(fitResiduals), weightedSquaredResidual: usable ? evaluate(estimate).cost : null },
    heldOut: { residuals: heldOutResiduals, rmsM: rms(heldOutResiduals), independence: r.heldOutIndependence, usedForEstimation: false },
    fieldAccuracyEstablished: false, canonicalAdmission: false };
  return { ...payload, digest: replayDigest(payload) };
}
