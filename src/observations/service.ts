import { byteDigest } from '../data-os/evidence-capture';
import { LocalEvidenceIntake } from '../data-os/local-intake';
import { publishImmutableFile, readImmutableFile } from '../data-os/local-files';
import { encodeLocalRecord, exactFields } from '../data-os/local-record';
import { evaluateSourceUse } from '../data-os/source-policy';
import { parseISOInstant } from '../data-os/validation';
import { ProductionError } from '../production/errors';
import { id, reference, type EvidenceReference } from '../spatial/contracts';
import { MAX_REPLAY_BYTES, parseBundle, replayDigest } from './contracts';
import { parsePairs, replay, REPLAY_METHOD, type ReplayPair, type ReplayResult } from './replay';
export interface ReplayRequest { schema: 'payload.observation-replay-request.v1'; requestId: string; purpose: string; source: EvidenceReference; pairs: ReplayPair[] }
function request(input: unknown): ReplayRequest {
  try {
    const v: unknown = JSON.parse(encodeLocalRecord(input, 16 * 1024).toString('utf8'));
    exactFields(v, ['schema', 'requestId', 'purpose', 'source', 'pairs']);
    if (v.schema !== 'payload.observation-replay-request.v1') throw new Error(); id(v.requestId); id(v.purpose); reference(v.source);
    return { schema: v.schema, requestId: v.requestId, purpose: v.purpose, source: v.source, pairs: parsePairs(v.pairs) };
  } catch { throw new ProductionError('INVALID_REPLAY_REQUEST', 'Supply an exact observation bundle reference and bounded replay comparisons.'); }
}
const path = (kind: string, key: string) => ['observation-replay', kind, `${byteDigest(Buffer.from(key)).slice(7)}.json`];
interface Reservation { request: ReplayRequest; startedAt: string; digest: string }
interface Receipt { schema: 'payload.observation-replay-receipt.v1'; request: ReplayRequest; reservationDigest: string; startedAt: string; completedAt: string; decisions: ReturnType<typeof evaluateSourceUse>[]; result: ReplayResult; digest: string }
const invalid = () => new ProductionError('INVALID_RETAINED_REPLAY', 'The saved replay or its retained source evidence failed verification.', 503);
const incomplete = () => new ProductionError('REPLAY_INCOMPLETE', 'The request is reserved without a confirmed receipt. Inspect it; a deliberate new execution requires a new id.', 409);
export class ObservationReplayService {
  private intake: LocalEvidenceIntake;
  constructor(private root: string, private clock = () => new Date().toISOString(), private compute = replay) { this.intake = new LocalEvidenceIntake(root); }
  private read<T>(kind: string, key: string): T | undefined {
    const bytes = readImmutableFile(this.root, path(kind, key), MAX_REPLAY_BYTES);
    return bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T : undefined;
  }
  private inputs(r: ReplayRequest, at: string) {
    const verify = (ref: EvidenceReference) => {
      const a = this.intake.inspect(ref.acquisition.id);
      if (!a || a.digest !== ref.acquisition.digest || a.request.contentDigest !== ref.evidence.contentDigest || a.request.manifest.evidenceId !== ref.evidence.id) throw new ProductionError('REPLAY_SOURCE_MISMATCH', 'An exact retained source reference does not verify.', 409);
      if (parseISOInstant(a.capture.receipt.storedAt, 'storedAt') > parseISOInstant(at, 'execution')) throw new ProductionError('REPLAY_SOURCE_TIME', 'All sources must be retained before replay.');
      const policy = a.request.manifest.sourceRegistration;
      const decision = evaluateSourceUse(policy, { requestId: `${r.requestId}:derive`, registrationId: policy.registrationId, purpose: r.purpose, operation: 'DERIVE', audience: 'INTERNAL', requestedAt: at });
      if (decision.state !== 'ALLOWED') throw new ProductionError('REPLAY_PROCESSING_DISALLOWED', 'Source policy does not allow this replay.', 403);
      return { acquisition: a, decision };
    };
    const primary = verify(r.source), bytes = this.intake.objects.get(r.source.evidence.contentDigest)!;
    if (primary.acquisition.request.manifest.mediaType !== 'application/json' || bytes.length > MAX_REPLAY_BYTES) throw new ProductionError('REPLAY_SOURCE_FORMAT', 'Replay requires a bounded retained JSON bundle.');
    let bundle;
    try { bundle = parseBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw new ProductionError('INVALID_OBSERVATION_BUNDLE', 'The retained observation bundle does not satisfy the v1 contract.'); }
    return { bundle, decisions: [primary.decision, ...bundle.artifacts.map(a => verify(a.reference).decision)] };
  }
  inspect(requestId: string) {
    try { id(requestId); } catch { throw new ProductionError('INVALID_REPLAY_ID', 'Supply a bounded replay id.'); }
    try {
      const reservation = this.read<Reservation>('requests', requestId), receipt = this.read<Receipt>('receipts', requestId);
      if (!reservation && !receipt) return undefined;
      if (!reservation) throw invalid();
      exactFields(reservation, ['request', 'startedAt', 'digest']); const { digest: rd, ...rp } = reservation;
      const r = request(reservation.request); if (r.requestId !== requestId || replayDigest(rp) !== rd) throw invalid();
      if (!receipt) throw incomplete();
      exactFields(receipt, ['schema', 'request', 'reservationDigest', 'startedAt', 'completedAt', 'decisions', 'result', 'digest']); const { digest: d, ...payload } = receipt;
      if (receipt.schema !== 'payload.observation-replay-receipt.v1' || replayDigest(payload) !== d || receipt.reservationDigest !== rd || replayDigest(receipt.request) !== replayDigest(r) || receipt.startedAt !== reservation.startedAt || parseISOInstant(receipt.completedAt, 'completedAt') < parseISOInstant(receipt.startedAt, 'startedAt')) throw invalid();
      const { bundle, decisions } = this.inputs(r, receipt.startedAt);
      exactFields(receipt.result, ['schema', 'bundleDigest', 'classification', 'method', 'parameters', 'frame', 'referenceClock', 'readings', 'comparisons', 'coverage', 'fieldAccuracyEstablished', 'physicalActionAuthorized', 'digest']);
      const { digest: resultDigest, ...result } = receipt.result;
      if (result.schema !== 'payload.observation-replay-result.v1' || replayDigest(result) !== resultDigest || result.bundleDigest !== replayDigest(bundle) || replayDigest(result.method) !== replayDigest(REPLAY_METHOD) || replayDigest(result.parameters) !== replayDigest({ pairs: r.pairs }) || replayDigest(result.frame) !== replayDigest(bundle.worldFrame) || replayDigest(result.referenceClock) !== replayDigest(bundle.referenceClock) || result.classification !== bundle.classification || result.fieldAccuracyEstablished !== false || result.physicalActionAuthorized !== false || replayDigest(decisions) !== replayDigest(receipt.decisions)) throw invalid();
      return { receipt, projection: { schema: 'payload.observation-replay-projection.v1', sourceKind: 'LOCAL_ANALYSIS', source: r.source, receiptDigest: d, bundle, result: receipt.result, inspection: 'HISTORICAL', currentRightsGrant: false, canonicalAdmission: false } };
    } catch (e) { if (e instanceof ProductionError && e.code === 'REPLAY_INCOMPLETE') throw e; throw invalid(); }
  }
  submit(input: unknown) {
    const r = request(input), previous = this.inspect(r.requestId);
    if (previous) { if (replayDigest(previous.receipt.request) !== replayDigest(r)) throw new ProductionError('REPLAY_REQUEST_CONFLICT', 'This request id already binds different inputs.', 409); return { status: 'EXISTING', ...previous }; }
    const startedAt = this.clock(), { bundle, decisions } = this.inputs(r, startedAt);
    if (r.pairs.some(p => !bundle.observations.some(o => o.id === p.leftId) || !bundle.observations.some(o => o.id === p.rightId))) throw new ProductionError('REPLAY_PAIR_MISSING', 'A requested comparison observation is missing.');
    const rp = { request: r, startedAt }, reservation = { ...rp, digest: replayDigest(rp) };
    try { if (publishImmutableFile(this.root, path('requests', r.requestId), encodeLocalRecord(reservation, MAX_REPLAY_BYTES), MAX_REPLAY_BYTES) !== 'CREATED') throw incomplete(); } catch { throw incomplete(); }
    const result = this.compute(bundle, r.pairs), payload = { schema: 'payload.observation-replay-receipt.v1' as const, request: r, reservationDigest: reservation.digest, startedAt, completedAt: this.clock(), decisions, result };
    const receipt = { ...payload, digest: replayDigest(payload) };
    publishImmutableFile(this.root, path('receipts', r.requestId), encodeLocalRecord(receipt, MAX_REPLAY_BYTES), MAX_REPLAY_BYTES);
    return { status: 'CREATED', ...this.inspect(r.requestId)! };
  }
}
