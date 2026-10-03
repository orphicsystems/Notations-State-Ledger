import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceRegistration } from '../data-os/contracts';
import { byteDigest, storageKeyFor } from '../data-os/evidence-capture';
import type { ProductionCommand, ProductionCorpusDefinition, ProductionOutputRef, ProductionRef, ProductionResult, ProductionSourceConfig } from './contracts';
import { LocalMaintenanceStore } from './maintenance';
import { LocalProductionStore } from './store';

let temporary: string;
let root: string;
let now: string;
let production: LocalProductionStore;
let maintenance: LocalMaintenanceStore;
const content = readFileSync('examples/carrier/source.json');
const policy = JSON.parse(readFileSync('examples/carrier/acquisition.json', 'utf8')).sourceRegistration as SourceRegistration;
const purpose = 'CARAVAN_LOCAL_DEVELOPMENT';
const ref = (value: ProductionRef): ProductionRef => ({ id: value.id, digest: value.digest });
const output = (result: ProductionResult, kind: ProductionOutputRef['kind']): ProductionOutputRef => {
  const value = result.run.outputs.find((entry) => entry.kind === kind);
  expect(value).toBeDefined();
  return value!;
};
function command<T extends Omit<ProductionCommand, 'schema' | 'requestId'>>(requestId: string, value: T) {
  return { schema: 'payload.production-command.v1', requestId, ...value };
}
function register(suffix = 'primary') {
  const definition: ProductionCorpusDefinition = { schema: 'payload.production-corpus-definition.v1', id: `corpus-${suffix}`, version: '1.0.0',
    domain: 'CARAVAN', recordType: 'Carrier', requiredSubjects: ['Carrier'], requiredFields: ['legalName'],
    coverage: { geography: `Synthetic ${suffix} scope`, temporal: 'One supplied artifact' }, freshness: 'Operator selected; no freshness measured',
    evidenceClasses: ['OPERATOR_DECLARATION'], intendedUses: [purpose] };
  const corpus = ref(output(production.execute(command(`register-corpus-${suffix}`, { kind: 'REGISTER_CORPUS', definition })), 'CORPUS'));
  const source: ProductionSourceConfig = { schema: 'payload.production-source-config.v1', id: `source-${suffix}`, version: '1.0.0', corpus,
    provider: 'Notation Systems synthetic demonstration', method: 'LOCAL_INLINE_BYTES', adapter: { id: 'caravan.carrier-json/v1', version: '1.0.0' },
    supportedCoverage: definition.coverage, policy: structuredClone(policy) };
  const sourceRef = ref(output(production.execute(command(`register-source-${suffix}`, { kind: 'REGISTER_SOURCE', source })), 'SOURCE'));
  return { corpus, source: sourceRef };
}
function capture(source: ProductionRef, requestId: string, bytes = content) {
  return production.execute(command(requestId, { kind: 'ACQUIRE', source, purpose, contentBase64: bytes.toString('base64') }));
}
function chain(suffix = 'primary') {
  const registered = register(suffix);
  const acquired = capture(registered.source, `capture-${suffix}`);
  const acquisition = output(acquired, 'ACQUISITION');
  const normalized = production.execute(command(`normalize-${suffix}`, { kind: 'NORMALIZE', source: registered.source, acquisition: ref(acquisition), purpose }));
  const normalization = output(normalized, 'NORMALIZATION');
  const built = production.execute(command(`build-${suffix}`, { kind: 'BUILD_CANDIDATES', corpus: registered.corpus, members: [ref(normalization)], purpose }));
  const build = output(built, 'CANDIDATE_BUILD');
  expect([acquired.run.state, normalized.run.state, built.run.state]).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
  return { ...registered, acquisition, normalization, build, runs: [acquired, normalized, built].map((result) => ref(result.run)) };
}
function request(target: ProductionOutputRef, runs: ProductionRef[], replacement: ProductionOutputRef | null = null, requestId = 'maintenance-1') {
  return { schema: 'payload.maintenance-request.v1', requestId, kind: replacement ? 'CORRECTION' : 'WITHDRAWAL', target, replacement,
    reason: replacement ? 'Operator supplied a corrected source artifact.' : 'Operator withdrew support for this artifact.', runs };
}
function diskFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name);
    return lstatSync(path).isDirectory() ? diskFiles(path) : [path];
  });
}
function snapshot() { return Object.fromEntries(diskFiles(root).map((path) => [path, byteDigest(readFileSync(path))])); }
const incorrect = (value: ProductionRef) => ({ ...ref(value), digest: `sha256:${'0'.repeat(64)}` });

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'payload-maintenance-test-')); root = join(temporary, 'evidence');
  now = '2026-09-06T12:00:00.000Z'; production = new LocalProductionStore(root, () => now); maintenance = new LocalMaintenanceStore(root, () => now);
});
afterEach(() => { rmSync(temporary, { recursive: true, force: true }); });

describe('local corpus maintenance using retained production evidence', () => {
  it.each(['CORRECTION', 'WITHDRAWAL'] as const)('traces %s from an acquisition through normalization and candidate assembly without executing changes', (kind) => {
    const pipeline = chain();
    const corrected = Buffer.from(JSON.stringify({ ...JSON.parse(content.toString()), legalName: 'Corrected Demonstration Carrier' }));
    const replacement = kind === 'CORRECTION' ? output(capture(pipeline.source, 'corrected-source', corrected), 'ACQUISITION') : null;
    const before = snapshot();
    const result = maintenance.plan(request(pipeline.acquisition, pipeline.runs, replacement));
    const consequence = kind === 'CORRECTION' ? 'RESTATED' : 'UNSUPPORTED';
    expect(result.status).toBe('CREATED');
    expect(result.plan).toMatchObject({ plannedAt: now, request: { kind, target: pipeline.acquisition, replacement },
      coverage: { basis: 'SELECTED_RUNS_ONLY', runCount: 3, excludedRuns: [], completenessClaimed: false },
      canonicalAdmission: false, releaseActivated: false, executionAuthorized: false });
    expect(result.plan.affected).toHaveLength(2);
    expect(result.plan.affected).toEqual(expect.arrayContaining([
      { reference: pipeline.normalization, consequence, depth: 1, via: pipeline.acquisition, action: 'REVIEW_NORMALIZATION' },
      { reference: pipeline.build, consequence, depth: 2, via: pipeline.normalization, action: 'REVIEW_CANDIDATE_BUILD' },
    ]));
    for (const [path, digest] of Object.entries(before)) expect(byteDigest(readFileSync(path))).toBe(digest);
    expect(production.catalog().runs).toHaveLength(kind === 'CORRECTION' ? 6 : 5);
    expect(production.inspect('CANDIDATE_BUILD', ref(pipeline.build))).toMatchObject({ data: { state: 'UNADMITTED', releaseActivated: false } });
    expect(maintenance.inspect(ref(result.plan))).toEqual(result.plan);
  });

  it('starts at a selected normalization without marking its upstream acquisition affected', () => {
    const pipeline = chain();
    const { plan } = maintenance.plan(request(pipeline.normalization, pipeline.runs));
    expect(plan.affected).toEqual([{ reference: pipeline.build, consequence: 'UNSUPPORTED', depth: 1, via: pipeline.normalization, action: 'REVIEW_CANDIDATE_BUILD' }]);
  });

  it('keeps unrelated corpus outputs out of the impact set and does not discover unselected downstream runs', () => {
    const selected = chain(); const unrelated = chain('unrelated');
    const unselected = production.execute(command('unselected-build', { kind: 'BUILD_CANDIDATES', corpus: selected.corpus, members: [ref(selected.normalization)], purpose }));
    const { plan } = maintenance.plan(request(selected.acquisition, [...selected.runs, ...unrelated.runs]));
    expect(plan.coverage).toMatchObject({ runCount: 6, completenessClaimed: false });
    expect(plan.affected.map((entry) => entry.reference)).toEqual(expect.arrayContaining([selected.normalization, selected.build]));
    expect(plan.affected).toHaveLength(2);
    expect(plan.affected.map((entry) => entry.reference.id)).not.toContain(output(unselected, 'CANDIDATE_BUILD').id);
  });

  it('does not claim a clean result when selected builds omit the normalization run needed to reach them', () => {
    const pipeline = chain();
    const { plan } = maintenance.plan(request(pipeline.acquisition, [pipeline.runs[2]]));
    expect(plan.affected).toEqual([]);
    expect(plan).toMatchObject({ targetAction: 'REVIEW_TARGET', untrackedDependents: 'UNDETERMINED',
      coverage: { basis: 'SELECTED_RUNS_ONLY', runCount: 1, missingProducerRuns: 'UNTRAVERSED', completenessClaimed: false } });
    expect(JSON.stringify(plan)).not.toContain('CLEAN');
  });
  it('reports selected quarantined runs without treating their retained outputs as successful dependencies', () => {
    const pipeline = chain();
    const malformed = capture(pipeline.source, 'malformed-source', Buffer.from('{'));
    const quarantined = production.execute(command('quarantined-normalization', { kind: 'NORMALIZE', source: pipeline.source, acquisition: ref(output(malformed, 'ACQUISITION')), purpose }));
    expect(quarantined.run.state).toBe('QUARANTINED');
    const { plan } = maintenance.plan(request(output(malformed, 'ACQUISITION'), [...pipeline.runs, ref(quarantined.run)]));
    expect(plan.coverage).toMatchObject({ runCount: 4, excludedRuns: [{ reference: ref(quarantined.run), state: 'QUARANTINED' }], completenessClaimed: false });
    expect(plan.affected).toHaveLength(0);
  });

  it.each(['target', 'replacement', 'run'] as const)('rejects an inexact %s digest without writing a maintenance record', (field) => {
    const pipeline = chain();
    const replacement = output(capture(pipeline.source, 'corrected-source'), 'ACQUISITION');
    const input = request(pipeline.acquisition, pipeline.runs, replacement);
    if (field === 'target') input.target = { ...pipeline.acquisition, ...incorrect(pipeline.acquisition) };
    else if (field === 'replacement') input.replacement = { ...replacement, ...incorrect(replacement) };
    else input.runs = [incorrect(pipeline.runs[0]), ...pipeline.runs.slice(1)];
    const before = snapshot();
    expect(() => maintenance.plan(input)).toThrow(expect.objectContaining({ code: 'REFERENCE_MISMATCH' }));
    expect(snapshot()).toEqual(before);
  });

  it('returns a byte-identical historical plan after restart and ignores the later clock', () => {
    const pipeline = chain(); const input = request(pipeline.acquisition, pipeline.runs);
    const first = maintenance.plan(input); const before = snapshot();
    now = '2026-10-01T12:00:00.000Z';
    maintenance = new LocalMaintenanceStore(root, () => now);
    expect(maintenance.plan(input)).toEqual({ status: 'EXISTING', plan: first.plan });
    expect(maintenance.plan({ ...input, runs: [...input.runs].reverse() })).toEqual({ status: 'EXISTING', plan: first.plan });
    expect(maintenance.inspect(ref(first.plan))).toEqual(first.plan);
    expect(snapshot()).toEqual(before);
  });

  it('refuses to reuse a request identifier for changed operator intent or changed selected scope', () => {
    const pipeline = chain(); const input = request(pipeline.acquisition, pipeline.runs);
    maintenance.plan(input); const before = snapshot();
    for (const changed of [{ ...input, reason: 'A different maintenance decision.' }, { ...input, runs: pipeline.runs.slice(1) }]) {
      expect(() => maintenance.plan(changed)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_REQUEST_CONFLICT' }));
      expect(snapshot()).toEqual(before);
    }
  });

  it('requires an exact digest when inspecting a retained plan', () => {
    const pipeline = chain(); const result = maintenance.plan(request(pipeline.acquisition, pipeline.runs));
    const before = snapshot();
    expect(() => maintenance.inspect(incorrect(result.plan))).toThrow(expect.objectContaining({ code: 'MAINTENANCE_REFERENCE_MISMATCH' }));
    expect(snapshot()).toEqual(before);
  });

  it('detects tampered maintenance records on both inspection and retry without silently replacing them', () => {
    const pipeline = chain(); const input = request(pipeline.acquisition, pipeline.runs);
    const { plan } = maintenance.plan(input);
    const retainedPath = diskFiles(root).find((path) => {
      if (!path.endsWith('.json')) return false;
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return value.id === plan.id && value.digest === plan.digest;
    });
    expect(retainedPath).toBeDefined();
    const altered = { ...plan, affected: [], executionAuthorized: true };
    writeFileSync(retainedPath!, JSON.stringify(altered));
    const before = snapshot();
    maintenance = new LocalMaintenanceStore(root, () => now);
    expect(() => maintenance.inspect(ref(plan))).toThrow(expect.objectContaining({ code: 'MAINTENANCE_INTEGRITY_FAILED' }));
    expect(() => maintenance.plan(input)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_INTEGRITY_FAILED' }));
    expect(snapshot()).toEqual(before);
  });

  it.each(['target', 'selected run'] as const)('refuses a plan clock earlier than the %s without retaining a plan', (boundary) => {
    const pipeline = chain();
    let runs = pipeline.runs;
    if (boundary === 'selected run') {
      now = '2026-09-07T12:00:00.000Z';
      const later = production.execute(command('later-normalization', { kind: 'NORMALIZE', source: pipeline.source, acquisition: ref(pipeline.acquisition), purpose }));
      expect(later.run.state).toBe('COMPLETED');
      runs = [ref(later.run)];
      now = '2026-09-06T12:00:00.000Z';
    } else now = '2026-09-05T12:00:00.000Z';
    const before = snapshot();
    expect(() => maintenance.plan(request(pipeline.acquisition, runs))).toThrow(expect.objectContaining({ code: 'MAINTENANCE_CLOCK_ORDER' }));
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(root, 'maintenance-v1'))).toBe(false);
  });

  it('invalidates inspection and retry when source bytes change after a plan is retained', () => {
    const pipeline = chain(); const input = request(pipeline.acquisition, pipeline.runs);
    const { plan } = maintenance.plan(input);
    const evidencePath = join(root, 'objects', ...storageKeyFor(byteDigest(content)).split('/'));
    writeFileSync(evidencePath, 'Tampered source bytes');
    const before = snapshot();
    maintenance = new LocalMaintenanceStore(root, () => now);
    expect(() => maintenance.inspect(ref(plan))).toThrow(expect.objectContaining({ code: 'MAINTENANCE_INTEGRITY_FAILED' }));
    expect(() => maintenance.plan(input)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_INTEGRITY_FAILED' }));
    expect(snapshot()).toEqual(before);
  });
  it('requires bounded explicit scope and rejects ambiguous correction or withdrawal requests before writing', () => {
    const pipeline = chain(); const base = request(pipeline.acquisition, pipeline.runs);
    const before = snapshot();
    for (const invalid of [
      { ...base, runs: [] },
      { ...base, runs: Array.from({ length: 129 }, () => pipeline.runs[0]) },
      { ...base, runs: [pipeline.runs[0], pipeline.runs[0]] },
      { ...base, kind: 'CORRECTION', replacement: null },
      { ...base, kind: 'CORRECTION', replacement: pipeline.acquisition },
      { ...base, kind: 'WITHDRAWAL', replacement: pipeline.acquisition },
      { ...base, reason: '' },
      { ...base, executionAuthorized: true },
    ]) {
      expect(() => maintenance.plan(invalid)).toThrow();
      expect(snapshot()).toEqual(before);
    }
  });
});
