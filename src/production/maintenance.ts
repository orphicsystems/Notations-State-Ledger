import { resolve } from 'node:path';
import { publishImmutableFile, readImmutableFile } from '../data-os/local-files';
import { encodeLocalRecord, exactFields, localJson, localRecordDigest } from '../data-os/local-record';
import { parseISOInstant, requireText } from '../data-os/validation';
import type { RetractionKind } from '../domain/corpus';
import type { Consequence } from '../domain/dependencyIndex';
import { parseProductionRef, productionId, type ProductionRef, type ProductionRun } from './contracts';
import { ProductionError } from './errors';
import { LocalProductionStore } from './store';

export const MAX_MAINTENANCE_BYTES = 512 * 1024;
export interface MaintenanceRef extends ProductionRef {
  kind: 'ACQUISITION' | 'NORMALIZATION' | 'CANDIDATE_BUILD';
}
export interface MaintenanceRequest {
  schema: 'payload.maintenance-request.v1'; requestId: string; kind: RetractionKind;
  target: MaintenanceRef; replacement: MaintenanceRef | null; reason: string; runs: ProductionRef[];
}
export interface MaintenanceImpact {
  reference: MaintenanceRef; consequence: Consequence; depth: number; via: MaintenanceRef;
  action: 'REVIEW_NORMALIZATION' | 'REVIEW_CANDIDATE_BUILD';
}
export interface MaintenancePlan {
  schema: 'payload.maintenance-plan.v1'; id: string; plannedAt: string; request: MaintenanceRequest;
  mode: 'LOCAL_DEVELOPMENT'; basis: 'OPERATOR_DECLARED_ARTIFACT_CHANGE'; replacementRelationVerified: false;
  targetAction: 'REVIEW_TARGET'; affected: MaintenanceImpact[];
  coverage: { basis: 'SELECTED_RUNS_ONLY'; runCount: number; excludedRuns: { reference: ProductionRef; state: ProductionRun['state'] }[];
    completenessClaimed: false; missingProducerRuns: 'UNTRAVERSED' };
  untrackedDependents: 'UNDETERMINED'; pathSemantics: 'ONE_SHORTEST_PREDECESSOR';
  canonicalAdmission: false; releaseActivated: false; executionAuthorized: false;
  currentRightsGrant: false; notificationsSent: false; digest: string;
}
const key = (ref: MaintenanceRef) => localJson(ref);
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function artifact(value: unknown): MaintenanceRef {
  exactFields(value, ['kind', 'id', 'digest']);
  if (!['ACQUISITION', 'NORMALIZATION', 'CANDIDATE_BUILD'].includes(String(value.kind))) throw new Error();
  return { kind: value.kind as MaintenanceRef['kind'], ...parseProductionRef({ id: value.id, digest: value.digest }) };
}
export function parseMaintenanceRequest(input: unknown): MaintenanceRequest {
  try {
    const value = JSON.parse(encodeLocalRecord(input, MAX_MAINTENANCE_BYTES).toString('utf8'));
    exactFields(value, ['schema', 'requestId', 'kind', 'target', 'replacement', 'reason', 'runs']);
    if (value.schema !== 'payload.maintenance-request.v1' || !['CORRECTION', 'WITHDRAWAL'].includes(String(value.kind))) throw new Error();
    productionId(value.requestId); requireText(value.reason, 'reason', 512);
    const target = artifact(value.target);
    const replacement = value.replacement === null ? null : artifact(value.replacement);
    if (value.kind === 'WITHDRAWAL' ? replacement !== null : !replacement || replacement.kind !== target.kind || replacement.id === target.id) throw new Error();
    if (!Array.isArray(value.runs) || !value.runs.length || value.runs.length > 128) throw new Error();
    const runs = value.runs.map(parseProductionRef).sort((a, b) => ordered(a.id, b.id));
    if (new Set(runs.map((ref) => ref.id)).size !== runs.length) throw new Error();
    return { schema: 'payload.maintenance-request.v1', requestId: value.requestId, kind: value.kind as RetractionKind,
      target, replacement, reason: value.reason as string, runs };
  } catch { throw new ProductionError('INVALID_MAINTENANCE_REQUEST', 'Provide an operator-declared change and 1–128 unique exact run references; a correction requires a distinct same-kind replacement.'); }
}

/** Local artifact maintenance only. It does not create a canonical corpus retraction. */
export class LocalMaintenanceStore {
  readonly root: string;
  private readonly production: LocalProductionStore;
  constructor(root: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.root = resolve(root); this.production = new LocalProductionStore(this.root);
  }
  private path(id: string) {
    productionId(id);
    return ['maintenance-v1', 'plans', `${localRecordDigest(id).slice(7)}.json`];
  }
  private compute(request: MaintenanceRequest, plannedAt: string): MaintenancePlan {
    const cutoff = parseISOInstant(plannedAt, 'plannedAt');
    const inspect = (ref: MaintenanceRef) => {
      this.production.inspect(ref.kind, { id: ref.id, digest: ref.digest });
      const at = ref.kind === 'ACQUISITION' ? this.production.intake.inspect(ref.id)!.request.manifest.capturedAt
        : ref.kind === 'NORMALIZATION' ? this.production.normalizations.inspect(ref.id)!.normalizedAt
          : this.production.builds.inspect(ref.id)!.builtAt;
      if (parseISOInstant(at, 'artifact time') > cutoff) throw new ProductionError('MAINTENANCE_CLOCK_ORDER', 'The plan cannot precede a selected retained artifact.', 409);
    };
    inspect(request.target);
    if (request.replacement) inspect(request.replacement);
    const edges: { from: MaintenanceRef; to: MaintenanceRef }[] = [];
    const excludedRuns: { reference: ProductionRef; state: ProductionRun['state'] }[] = [];
    for (const ref of request.runs) {
      const run = this.production.inspect('RUN', ref).data as ProductionRun;
      if (parseISOInstant(run.completedAt, 'completedAt') > cutoff) throw new ProductionError('MAINTENANCE_CLOCK_ORDER', 'The plan cannot precede a selected run.', 409);
      if (run.state !== 'COMPLETED') { excludedRuns.push({ reference: ref, state: run.state }); continue; }
      const outputKind = run.request.kind === 'NORMALIZE' ? 'NORMALIZATION'
        : run.request.kind === 'BUILD_CANDIDATES' ? 'CANDIDATE_BUILD' : null;
      if (!outputKind) continue;
      // Outputs also contain inputs. Only the operation's own produced kind is a dependent.
      const outputs = run.outputs.filter((output) => output.kind === outputKind);
      if (outputs.length !== 1) throw new ProductionError('MAINTENANCE_LINEAGE_INVALID', 'A selected completed run has no unique produced artifact.', 409);
      const to = artifact(outputs[0]); inspect(to);
      const inputs = outputKind === 'NORMALIZATION'
        ? [{ kind: 'ACQUISITION', ...parseProductionRef(run.request.acquisition) }]
        : (run.request.members as unknown[]).map((member) => ({ kind: 'NORMALIZATION', ...parseProductionRef(member) }));
      for (const input of inputs) { const from = artifact(input); inspect(from); edges.push({ from, to }); }
    }
    // Canonical input order makes diamonds pick the same shortest predecessor on replay.
    edges.sort((a, b) => ordered(key(a.from), key(b.from)) || ordered(key(a.to), key(b.to)));
    const standing = new Map<string, MaintenanceRef[]>();
    for (const edge of edges) standing.set(key(edge.from), [...(standing.get(key(edge.from)) ?? []), edge.to]);
    const visited = new Set([key(request.target)]);
    const queue = [{ reference: request.target, depth: 0 }];
    const affected: MaintenanceImpact[] = [];
    for (let position = 0; position < queue.length; position += 1) {
      const step = queue[position];
      for (const dependent of standing.get(key(step.reference)) ?? []) {
        if (visited.has(key(dependent))) continue;
        visited.add(key(dependent));
        const depth = step.depth + 1;
        affected.push({ reference: dependent, consequence: request.kind === 'WITHDRAWAL' ? 'UNSUPPORTED' : 'RESTATED', depth,
          via: step.reference, action: dependent.kind === 'NORMALIZATION' ? 'REVIEW_NORMALIZATION' : 'REVIEW_CANDIDATE_BUILD' });
        queue.push({ reference: dependent, depth });
      }
    }
    const payload = {
      schema: 'payload.maintenance-plan.v1' as const, id: request.requestId, plannedAt, request,
      mode: 'LOCAL_DEVELOPMENT' as const, basis: 'OPERATOR_DECLARED_ARTIFACT_CHANGE' as const,
      replacementRelationVerified: false as const, targetAction: 'REVIEW_TARGET' as const, affected,
      coverage: { basis: 'SELECTED_RUNS_ONLY' as const, runCount: request.runs.length, excludedRuns, completenessClaimed: false as const, missingProducerRuns: 'UNTRAVERSED' as const },
      untrackedDependents: 'UNDETERMINED' as const, pathSemantics: 'ONE_SHORTEST_PREDECESSOR' as const,
      canonicalAdmission: false as const, releaseActivated: false as const, executionAuthorized: false as const,
      currentRightsGrant: false as const, notificationsSent: false as const,
    };
    return { ...payload, digest: localRecordDigest(payload, MAX_MAINTENANCE_BYTES) };
  }
  private read(id: string): MaintenancePlan | undefined {
    try {
      const bytes = readImmutableFile(this.root, this.path(id), MAX_MAINTENANCE_BYTES);
      if (!bytes) return undefined;
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const request = parseMaintenanceRequest(saved.request);
      if (request.requestId !== id) throw new Error();
      const recomputed = this.compute(request, saved.plannedAt);
      if (localJson(saved) !== localJson(recomputed)) throw new Error();
      return recomputed;
    } catch { throw new ProductionError('MAINTENANCE_INTEGRITY_FAILED', 'The retained plan or its exact production dependencies did not verify; existing files were preserved.', 409); }
  }
  plan(input: unknown): { status: 'CREATED' | 'EXISTING'; plan: MaintenancePlan } {
    const request = parseMaintenanceRequest(input);
    const same = (plan: MaintenancePlan) => {
      if (localJson(plan.request) !== localJson(request)) throw new ProductionError('MAINTENANCE_REQUEST_CONFLICT', 'This plan identifier already names another request. Use a new identifier.', 409);
      return { status: 'EXISTING' as const, plan };
    };
    const existing = this.read(request.requestId);
    if (existing) return same(existing);
    const plan = this.compute(request, this.now());
    try {
      const status = publishImmutableFile(this.root, this.path(plan.id), encodeLocalRecord(plan, MAX_MAINTENANCE_BYTES), MAX_MAINTENANCE_BYTES);
      const retained = this.read(plan.id);
      if (!retained) throw new Error();
      return { status, plan: retained };
    } catch (error) {
      // A concurrent identical request may have won with its own backend time.
      const winner = this.read(plan.id);
      if (winner) return same(winner);
      if (error instanceof ProductionError) throw error;
      throw new ProductionError('MAINTENANCE_SAVE_UNCONFIRMED', 'The maintenance plan save could not be confirmed. Retry the identical request.', 503);
    }
  }
  inspect(input: ProductionRef): MaintenancePlan {
    const ref = parseProductionRef(input);
    const plan = this.read(ref.id);
    if (!plan) throw new ProductionError('MAINTENANCE_NOT_FOUND', 'The selected maintenance plan is not retained.', 404);
    if (plan.digest !== ref.digest) throw new ProductionError('MAINTENANCE_REFERENCE_MISMATCH', 'The selected maintenance plan does not match its digest.', 409);
    return plan;
  }
}
