import { encodeLocalRecord, exactFields } from '../data-os/local-record';
import { id, reference, parseRequest, digest, type EvidenceReference, type Scenario, type SpatialLayout } from '../spatial/contracts';
import { measureAccess, DISTANCE_METHOD, type AccessMetric } from '../spatial/distance';
import { apply } from '../observations/replay';
import { replayDigest, type Vec3 } from '../observations/contracts';
import { parseRegistration, registerRigid, REGISTRATION_METHOD, type RegistrationInput } from './rigid';
export interface CalibrationAccessInput {
  schema: 'payload.calibration-access-experiment.v1'; registration: RegistrationInput; layout: EvidenceReference;
  sourceAnchors: { evidence: EvidenceReference; frameId: string; points: { spaceId: string; pointM: Vec3 }[] };
  walkingLengths: { evidence: EvidenceReference; passages: { passageId: string; lengthM: number | null }[] };
  fromId: string; toId: string; scenario: Scenario; heldOutRmsLimitM: number;
}
export const EXPERIMENT_METHOD = { id: 'calibration-access-experiment', version: '1.0.0', registration: REGISTRATION_METHOD, distance: DISTANCE_METHOD, accuracy: 'NO_AUTOMATIC_FIELD_ACCURACY_CLAIM' } as const;
export function parseExperiment(input: unknown): CalibrationAccessInput {
  const v: unknown = JSON.parse(encodeLocalRecord(input, 1024 * 1024).toString('utf8'));
  exactFields(v, ['schema', 'registration', 'layout', 'sourceAnchors', 'walkingLengths', 'fromId', 'toId', 'scenario', 'heldOutRmsLimitM']);
  if (v.schema !== 'payload.calibration-access-experiment.v1') throw new Error('Unsupported calibration/access experiment.');
  v.registration = parseRegistration(v.registration); reference(v.layout); id(v.fromId); id(v.toId);
  exactFields(v.sourceAnchors, ['evidence', 'frameId', 'points']); reference(v.sourceAnchors.evidence); id(v.sourceAnchors.frameId);
  const r = v as unknown as CalibrationAccessInput;
  if (r.sourceAnchors.frameId !== r.registration.sourceFrameId || !Array.isArray(r.sourceAnchors.points) || r.sourceAnchors.points.length > 256) throw new Error('Anchor source frame must match the registration source frame.');
  const seen = new Set<string>();
  r.sourceAnchors.points.forEach(p => { exactFields(p, ['spaceId', 'pointM']); id(p.spaceId); if (seen.has(p.spaceId) || !Array.isArray(p.pointM) || p.pointM.length !== 3 || p.pointM.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10000)) throw new Error('Invalid source anchor.'); seen.add(p.spaceId); });
  exactFields(v.walkingLengths, ['evidence', 'passages']); reference(v.walkingLengths.evidence);
  if (!Array.isArray(r.walkingLengths.passages) || r.walkingLengths.passages.length > 1024) throw new Error('Passage lengths exceed the bounded scope.');
  r.walkingLengths.passages.forEach(p => { exactFields(p, ['passageId', 'lengthM']); id(p.passageId); if (p.lengthM !== null && (typeof p.lengthM !== 'number' || !Number.isFinite(p.lengthM) || p.lengthM < 0 || p.lengthM > 1e6)) throw new Error('Invalid walking length.'); });
  parseRequest({ schema: 'payload.spatial-analysis-request.v1', requestId: 'experiment-scenario', purpose: 'SPATIAL_INQUIRY', layout: r.layout, rootSpaceId: r.fromId, scenario: r.scenario });
  if (typeof r.heldOutRmsLimitM !== 'number' || !Number.isFinite(r.heldOutRmsLimitM) || r.heldOutRmsLimitM <= 0 || r.heldOutRmsLimitM > 100) throw new Error('Declare a finite held-out RMS threshold in metres.');
  r.sourceAnchors.points.sort((a, b) => a.spaceId < b.spaceId ? -1 : 1); r.walkingLengths.passages.sort((a, b) => a.passageId < b.passageId ? -1 : 1);
  return r;
}
export function runExperiment(input: CalibrationAccessInput, layout: SpatialLayout, source: EvidenceReference) {
  const r = parseExperiment(input);
  if (r.registration.referenceFrameId !== layout.frame.id || r.scenario.baselineLayoutDigest !== digest(layout)) throw new Error('Registration target and scenario must bind the exact layout frame and digest.');
  const registration = registerRigid(r.registration);
  let baseline = null, scenario = null, metric: AccessMetric | null = null;
  if (registration.transform) {
    metric = { schema: 'payload.access-metric.v1', layoutDigest: digest(layout), frameId: layout.frame.id, units: 'm', evidence: source, classification: r.registration.classification === 'SYNTHETIC' ? 'SYNTHETIC' : 'RECORDED_DECLARATION',
      anchors: r.sourceAnchors.points.map(p => ({ spaceId: p.spaceId, pointM: apply(registration.transform!, p.pointM) })), passages: r.walkingLengths.passages };
    const request = parseRequest({ schema: 'payload.spatial-analysis-request.v1', requestId: 'experiment-baseline', purpose: 'SPATIAL_INQUIRY', layout: r.layout, rootSpaceId: r.fromId, scenario: null });
    baseline = measureAccess(layout, request, metric, r.fromId, r.toId);
    scenario = measureAccess(layout, { ...request, scenario: r.scenario }, metric, r.fromId, r.toId);
  }
  const rms = registration.heldOut.rmsM;
  const payload = { schema: 'payload.calibration-access-result.v1', source, inputDigest: replayDigest(r), layoutDigest: digest(layout), method: EXPERIMENT_METHOD, registration,
    heldOutCheck: { limitM: r.heldOutRmsLimitM, rmsM: rms, status: rms === null ? 'UNAVAILABLE' : rms <= r.heldOutRmsLimitM ? 'WITHIN_DECLARED_TOLERANCE' : 'OUTSIDE_DECLARED_TOLERANCE', independentAccuracyEstablished: false },
    metric, baseline, scenario, scenarioChangedSourceLayout: false, fieldAccuracyEstablished: false, canonicalAdmission: false };
  return { ...payload, digest: replayDigest(payload) };
}
export type ExperimentResult = ReturnType<typeof runExperiment>;
