import { LocalEvidenceIntake } from '../data-os/local-intake';
import { publishImmutableFile, readImmutableFile } from '../data-os/local-files';
import { byteDigest } from '../data-os/evidence-capture';
import { exactFields, encodeLocalRecord } from '../data-os/local-record';
import { evaluateSourceUse } from '../data-os/source-policy';
import { parseISOInstant } from '../data-os/validation';
import { ProductionError } from '../production/errors';
import { id, reference, parseLayout, digest, type EvidenceReference } from '../spatial/contracts';
import { replayDigest } from '../observations/contracts';
import { parseExperiment, runExperiment, EXPERIMENT_METHOD, type ExperimentResult } from './experiment';
export interface ExperimentRequest { schema: 'payload.calibration-access-request.v1'; requestId: string; purpose: string; source: EvidenceReference }
function parse(input: unknown): ExperimentRequest {
  try { const v: unknown = JSON.parse(encodeLocalRecord(input, 8192).toString('utf8')); exactFields(v, ['schema', 'requestId', 'purpose', 'source']); if (v.schema !== 'payload.calibration-access-request.v1') throw new Error(); id(v.requestId); id(v.purpose); reference(v.source); return v as unknown as ExperimentRequest; }
  catch { throw new ProductionError('INVALID_CALIBRATION_ACCESS_REQUEST', 'Supply an exact retained experiment reference, purpose and request id.'); }
}
const MAX = 1024 * 1024;
const path = (kind: string, key: string) => ['calibration-access', kind, `${byteDigest(Buffer.from(key)).slice(7)}.json`];
interface Reservation { request: ExperimentRequest; startedAt: string; digest: string }
interface Receipt { schema: 'payload.calibration-access-receipt.v1'; request: ExperimentRequest; reservationDigest: string; startedAt: string; completedAt: string; decisions: ReturnType<typeof evaluateSourceUse>[]; result: ExperimentResult; digest: string }
const invalid = () => new ProductionError('INVALID_RETAINED_CALIBRATION_ACCESS', 'The saved experiment or its exact source bindings failed verification.', 503);
const incomplete = () => new ProductionError('CALIBRATION_ACCESS_INCOMPLETE', 'This execution is reserved without a confirmed receipt. Inspect it; deliberate re-execution requires a new id.', 409);
export class CalibrationAccessService {
  private intake: LocalEvidenceIntake;
  constructor(private root: string, private clock = () => new Date().toISOString(), private compute = runExperiment) { this.intake = new LocalEvidenceIntake(root); }
  private read<T>(kind: string, key: string): T | undefined { const bytes = readImmutableFile(this.root, path(kind, key), MAX); return bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T : undefined; }
  private inputs(r: ExperimentRequest, at: string) {
    const decisions: ReturnType<typeof evaluateSourceUse>[] = [], seen = new Set<string>();
    const verify = (ref: EvidenceReference) => {
      const a = this.intake.inspect(ref.acquisition.id);
      if (!a || a.digest !== ref.acquisition.digest || a.request.contentDigest !== ref.evidence.contentDigest || a.request.manifest.evidenceId !== ref.evidence.id) throw new ProductionError('CALIBRATION_SOURCE_MISMATCH', 'An exact calibration/access source reference does not verify.', 409);
      if (parseISOInstant(a.capture.receipt.storedAt, 'storedAt') > parseISOInstant(at, 'execution')) throw new ProductionError('CALIBRATION_SOURCE_TIME', 'Retain all evidence before execution.');
      if (!seen.has(replayDigest(ref))) { const policy = a.request.manifest.sourceRegistration; const d = evaluateSourceUse(policy, { requestId: `${r.requestId}:derive`, registrationId: policy.registrationId, purpose: r.purpose, operation: 'DERIVE', audience: 'INTERNAL', requestedAt: at }); if (d.state !== 'ALLOWED') throw new ProductionError('CALIBRATION_PROCESSING_DISALLOWED', 'Source policy does not allow this experiment.', 403); decisions.push(d); seen.add(replayDigest(ref)); }
      return a;
    };
    const json = (ref: EvidenceReference) => { const a = verify(ref); if (a.request.manifest.mediaType !== 'application/json' || a.request.byteLength > MAX) throw new ProductionError('CALIBRATION_SOURCE_FORMAT', 'The experiment and layout must be bounded retained JSON.'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.intake.objects.get(ref.evidence.contentDigest)!)); };
    let input; try { input = parseExperiment(json(r.source)); } catch (e) { if (e instanceof ProductionError) throw e; throw new ProductionError('INVALID_CALIBRATION_INPUT', 'The retained experiment is outside the bounded v1 contract.'); }
    const layout = parseLayout(json(input.layout));
    [...layout.sourceArtifacts.map(a => a.reference), ...input.registration.fit.map(c => c.evidence), ...input.registration.heldOut.map(c => c.evidence), input.registration.noise.evidence, input.sourceAnchors.evidence, input.walkingLengths.evidence].forEach(verify);
    return { input, layout, decisions };
  }
  inspect(requestId: string) {
    try { id(requestId); } catch { throw new ProductionError('INVALID_CALIBRATION_ID', 'Supply a bounded request id.'); }
    try {
      const reservation = this.read<Reservation>('requests', requestId), receipt = this.read<Receipt>('receipts', requestId);
      if (!reservation && !receipt) return undefined; if (!reservation) throw invalid();
      exactFields(reservation, ['request', 'startedAt', 'digest']); const { digest: rd, ...reserved } = reservation, r = parse(reservation.request);
      if (r.requestId !== requestId || replayDigest(reserved) !== rd) throw invalid(); if (!receipt) throw incomplete();
      exactFields(receipt, ['schema', 'request', 'reservationDigest', 'startedAt', 'completedAt', 'decisions', 'result', 'digest']); const { digest: d, ...payload } = receipt;
      if (receipt.schema !== 'payload.calibration-access-receipt.v1' || replayDigest(payload) !== d || replayDigest(receipt.request) !== replayDigest(r) || receipt.reservationDigest !== rd || receipt.startedAt !== reservation.startedAt || parseISOInstant(receipt.completedAt, 'completedAt') < parseISOInstant(receipt.startedAt, 'startedAt')) throw invalid();
      const { input, layout, decisions } = this.inputs(r, receipt.startedAt);
      exactFields(receipt.result, ['schema', 'source', 'inputDigest', 'layoutDigest', 'method', 'registration', 'heldOutCheck', 'metric', 'baseline', 'scenario', 'scenarioChangedSourceLayout', 'fieldAccuracyEstablished', 'canonicalAdmission', 'digest']);
      const { digest: resultDigest, ...result } = receipt.result;
      if (result.schema !== 'payload.calibration-access-result.v1' || replayDigest(result) !== resultDigest || replayDigest(result.source) !== replayDigest(r.source) || result.inputDigest !== replayDigest(input) || result.layoutDigest !== digest(layout) || replayDigest(result.method) !== replayDigest(EXPERIMENT_METHOD) || result.fieldAccuracyEstablished !== false || result.canonicalAdmission !== false || result.scenarioChangedSourceLayout !== false || replayDigest(decisions) !== replayDigest(receipt.decisions)) throw invalid();
      return { receipt, projection: { schema: 'payload.calibration-access-projection.v1', sourceKind: 'LOCAL_ANALYSIS', source: r.source, receiptDigest: d, input, layout, result: receipt.result, inspection: 'HISTORICAL', currentRightsGrant: false, canonicalAdmission: false } };
    } catch (e) { if (e instanceof ProductionError && e.code === 'CALIBRATION_ACCESS_INCOMPLETE') throw e; throw invalid(); }
  }
  submit(value: unknown) {
    const r = parse(value), previous = this.inspect(r.requestId);
    if (previous) { if (replayDigest(previous.receipt.request) !== replayDigest(r)) throw new ProductionError('CALIBRATION_REQUEST_CONFLICT', 'This id already binds another experiment.', 409); return { status: 'EXISTING', ...previous }; }
    const startedAt = this.clock(), { input, layout, decisions } = this.inputs(r, startedAt);
    const reserved = { request: r, startedAt }, reservation = { ...reserved, digest: replayDigest(reserved) };
    try { if (publishImmutableFile(this.root, path('requests', r.requestId), encodeLocalRecord(reservation, MAX), MAX) !== 'CREATED') throw incomplete(); } catch { throw incomplete(); }
    const result = this.compute(input, layout, r.source), payload = { schema: 'payload.calibration-access-receipt.v1' as const, request: r, reservationDigest: reservation.digest, startedAt, completedAt: this.clock(), decisions, result }, receipt = { ...payload, digest: replayDigest(payload) };
    publishImmutableFile(this.root, path('receipts', r.requestId), encodeLocalRecord(receipt, MAX), MAX);
    return { status: 'CREATED', ...this.inspect(r.requestId)! };
  }
}
