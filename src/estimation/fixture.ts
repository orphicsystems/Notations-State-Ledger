import { LocalEvidenceIntake, type LocalIntakeManifest } from '../data-os/local-intake';
import { preserveFixture } from '../spatial/fixture';
import type { EvidenceReference } from '../spatial/contracts';
import { apply, inverseApply } from '../observations/replay';
import type { Vec3 } from '../observations/contracts';
import type { RegistrationInput } from './rigid';
import type { CalibrationAccessInput } from './experiment';
import { CalibrationAccessService, type ExperimentRequest } from './service';
export const EXPERIMENT_TIME = '2026-09-05T12:30:00.000Z';
export function preserveExperiment(root: string) {
  const spatial = preserveFixture(root), intake = new LocalEvidenceIntake(root);
  function capture(name: string, value: unknown): EvidenceReference {
    const manifest: LocalIntakeManifest = { schema: 'payload.local-intake-request.v1', acquisitionId: `calibration-${name}`, evidenceId: `calibration-evidence-${name}`, purpose: 'SPATIAL_INQUIRY', mediaType: 'application/json', capturedAt: '2026-09-05T12:00:00.000Z',
      sourceRegistration: { registrationId: `calibration-policy-${name}`, sourceId: `notation://source/calibration/${name}`, displayName: 'Synthetic calibration and access experiment', sourceClass: 'SYNTHETIC_DEMONSTRATION', licenseId: 'local-declaration', policyVersion: '1.0.0', effectiveFrom: '2026-09-01T00:00:00.000Z', permittedPurposes: ['SPATIAL_INQUIRY'], allowedOperations: ['INGEST', 'DERIVE'], allowedAudiences: ['INTERNAL'], retention: { mode: 'INDEFINITE' } } };
    const { acquisition: a } = intake.capture(manifest, Buffer.from(JSON.stringify(value, null, 2)), '2026-09-05T12:00:00.000Z');
    return { acquisition: { id: a.request.manifest.acquisitionId, digest: a.digest }, evidence: { id: a.request.manifest.evidenceId, contentDigest: a.request.contentDigest } };
  }
  const truth = { rotation: [[Math.cos(0.2), -Math.sin(0.2), 0], [Math.sin(0.2), Math.cos(0.2), 0], [0, 0, 1]], translationM: [2, 3, 0.5] as Vec3 };
  const points: Vec3[] = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 2], [2, 2, 2]], noise = [0.001, -0.001, 0.0005, -0.0005, 0];
  const fit = points.map((sourceM, i) => { const observedReferenceM = apply(truth, sourceM); observedReferenceM[0] += noise[i]; return { id: `C-${i}`, sourceM, observedReferenceM }; });
  const heldOut = [{ id: 'H-1', sourceM: [1, 1, 1] as Vec3, observedReferenceM: apply(truth, [1, 1, 1]) }]; heldOut[0].observedReferenceM[0] += 0.02;
  const covariance = Array.from({ length: 15 }, (_, i) => Array.from({ length: 15 }, (_, j) => (i === j ? 0.0001 : 0) + (i % 3 === j % 3 ? 0.000004 : 0)));
  const controlEvidence = capture('controls', { classification: 'SYNTHETIC', fit, heldOut, note: 'Generated controls, no independent survey; held-out x bias deliberately injected.' });
  const covarianceEvidence = capture('covariance', { covariance, controlOrder: fit.map(c => c.id), note: 'Synthetic 10 mm independent errors and 2 mm shared reference translation, not empirically calibrated.' });
  const anchors = spatial.layout.spaces.map((s, i) => ({ spaceId: s.id, pointM: inverseApply(truth, [2 + i * 5, 2, 0]) }));
  const anchorsEvidence = capture('model', { schema: 'payload.synthetic-building-anchors.v1', frameId: 'scan-fixture', units: 'm', anchors, note: 'Synthetic building model anchors; no IFC or surveyed building is represented.' });
  const lengths = spatial.layout.passages.map((p, i) => ({ passageId: p.id, lengthM: [7, 9, 8, 10][i] }));
  const lengthsEvidence = capture('walking-lengths', { units: 'm', passages: lengths, note: 'Assumed synthetic anchor-to-anchor walking lengths, not inferred from touching polygons.' });
  const registration: RegistrationInput = { schema: 'payload.rigid-registration.v1', sourceFrameId: 'scan-fixture', referenceFrameId: spatial.layout.frame.id, units: 'm', classification: 'SYNTHETIC', sourceTreatment: 'FIXED_CONDITIONAL', initial: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translationM: [0, 0, 0] }, fit: fit.map(c => ({ ...c, evidence: controlEvidence })), heldOut: heldOut.map(c => ({ ...c, evidence: controlEvidence })), noise: { convention: 'REFERENCE_XYZ_RESIDUAL_M2', controlOrder: fit.map(c => c.id), covariance, evidence: covarianceEvidence }, heldOutIndependence: 'SYNTHETIC' };
  const input: CalibrationAccessInput = { schema: 'payload.calibration-access-experiment.v1', registration, layout: spatial.baseline.layout,
    sourceAnchors: { evidence: anchorsEvidence, frameId: 'scan-fixture', points: anchors }, walkingLengths: { evidence: lengthsEvidence, passages: lengths }, fromId: 'S-1', toId: 'S-4', scenario: spatial.scenario.scenario!, heldOutRmsLimitM: 0.01 };
  const source = capture('experiment', input), request: ExperimentRequest = { schema: 'payload.calibration-access-request.v1', requestId: 'calibration-access-demo', purpose: 'SPATIAL_INQUIRY', source };
  return { input, request, layout: spatial.layout };
}
export function calibrationAccessFixture(root: string) {
  const fixture = preserveExperiment(root);
  return { ...fixture, analysis: new CalibrationAccessService(root, () => EXPERIMENT_TIME).submit(fixture.request) };
}
