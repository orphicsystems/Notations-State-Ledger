import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as PLAN } from '../app/api/production/maintenance/route';
import { POST as INSPECT } from '../app/api/production/maintenance/inspect/route';
import { CARAVAN_DEMO_DEFINITION, CARAVAN_DEMO_PURPOSE, caravanDemoContent, caravanDemoSource } from './demo';
import type { ProductionObjectKind, ProductionRef, ProductionResult } from './contracts';
import type { MaintenancePlan, MaintenanceRequest } from './maintenance';
import { LocalProductionStore } from './store';
import { runProductionWork, type ProductionWork } from './worker';

let root: string;
const prefix = join(tmpdir(), 'payload-maintenance-worker-');
const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
  'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const request = (body: unknown, suffix = '') => new Request(`http://127.0.0.1:3000/api/production/maintenance${suffix}`,
  { method: 'POST', headers, body: JSON.stringify(body) });
const ref = (result: ProductionResult, kind: ProductionObjectKind): ProductionRef => {
  const output = result.run.outputs.find((item) => item.kind === kind)!;
  return { id: output.id, digest: output.digest };
};
const runRef = (result: ProductionResult): ProductionRef => ({ id: result.run.id, digest: result.run.digest });
function files(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, files(path));
    else result[path] = readFileSync(path).toString('base64');
  }
  return result;
}
function specimen(): MaintenanceRequest {
  const store = new LocalProductionStore(root, () => '2026-09-03T12:00:00.000Z');
  const execute = (requestId: string, fields: Record<string, unknown>) =>
    store.execute({ schema: 'payload.production-command.v1', requestId, ...fields });
  const corpus = ref(execute('corpus', { kind: 'REGISTER_CORPUS', definition: CARAVAN_DEMO_DEFINITION }), 'CORPUS');
  const source = ref(execute('source', { kind: 'REGISTER_SOURCE', source: caravanDemoSource(corpus) }), 'SOURCE');
  const acquired = execute('acquire-before', { kind: 'ACQUIRE', source, purpose: CARAVAN_DEMO_PURPOSE, contentBase64: caravanDemoContent() });
  const acquisition = ref(acquired, 'ACQUISITION');
  const normalized = execute('normalize', { kind: 'NORMALIZE', source, acquisition, purpose: CARAVAN_DEMO_PURPOSE });
  const normalization = ref(normalized, 'NORMALIZATION');
  const built = execute('build', { kind: 'BUILD_CANDIDATES', corpus, members: [normalization], purpose: CARAVAN_DEMO_PURPOSE });
  const replacement = ref(execute('acquire-after', { kind: 'ACQUIRE', source, purpose: CARAVAN_DEMO_PURPOSE, contentBase64: caravanDemoContent() }), 'ACQUISITION');
  return { schema: 'payload.maintenance-request.v1', requestId: 'review-change', kind: 'CORRECTION',
    target: { kind: 'ACQUISITION', ...acquisition }, replacement: { kind: 'ACQUISITION', ...replacement },
    reason: 'Synthetic operator-declared change for workflow qualification.', runs: [runRef(normalized), runRef(built)] };
}
beforeEach(() => {
  root = mkdtempSync(prefix);
  vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '1'); vi.stubEnv('PAYLOAD_PRODUCTION_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (!resolve(root).startsWith(resolve(prefix))) throw new Error('Unexpected test cleanup target.');
  rmSync(root, { recursive: true, force: true });
});

describe('real maintenance HTTP route -> built worker -> retained production lineage', () => {
  it('plans, retries and reopens exact dependencies across worker processes without changing evidence', async () => {
    const input = specimen(); const prior = files(root);
    const response = await PLAN(request(input));
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await response.json() as { status: string; plan: MaintenancePlan };
    expect(saved.status).toBe('CREATED');
    expect(saved.plan).toMatchObject({ schema: 'payload.maintenance-plan.v1', canonicalAdmission: false,
      executionAuthorized: false, releaseActivated: false, replacementRelationVerified: false,
      coverage: { basis: 'SELECTED_RUNS_ONLY', runCount: 2, completenessClaimed: false } });
    expect(saved.plan.affected.map((impact) => [impact.reference.kind, impact.depth, impact.consequence])).toEqual([
      ['NORMALIZATION', 1, 'RESTATED'], ['CANDIDATE_BUILD', 2, 'RESTATED'],
    ]);
    const retained = files(root);
    expect(Object.keys(retained).filter((path) => !(path in prior))).toHaveLength(1);
    for (const [path, bytes] of Object.entries(prior)) expect(retained[path]).toBe(bytes);
    const retry = await PLAN(request(input));
    expect(await retry.json()).toEqual({ status: 'EXISTING', plan: saved.plan });
    const reopened = await INSPECT(request({ schema: 'payload.maintenance-inspection-request.v1',
      reference: { id: saved.plan.id, digest: saved.plan.digest } }, '/inspect'));
    expect(reopened.status, await reopened.clone().text()).toBe(200);
    expect(await reopened.json()).toEqual(saved.plan);
    expect(files(root)).toEqual(retained);
  });
  it('recomputes dependencies in the inspection worker and refuses a changed source without repairing it', async () => {
    const saved = await runProductionWork({ action: 'PLAN_MAINTENANCE', request: specimen() }) as { plan: MaintenancePlan };
    const store = new LocalProductionStore(root);
    const acquisition = store.intake.inspect(saved.plan.request.target.id)!;
    const objectFile = Object.keys(files(root)).find((path) => path.endsWith(acquisition.request.contentDigest.slice(7)))!;
    expect(objectFile).toBeDefined();
    writeFileSync(objectFile, 'corrupted retained source');
    const before = files(root);
    await expect(runProductionWork({ action: 'INSPECT_MAINTENANCE', reference: { id: saved.plan.id, digest: saved.plan.digest } }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_INTEGRITY_FAILED', status: 409 });
    expect(files(root)).toEqual(before);
  });
  it('rejects extra worker-envelope fields without accepting caller storage paths', async () => {
    const input = specimen(); const before = files(root);
    await expect(runProductionWork({ action: 'PLAN_MAINTENANCE', request: input, root: 'private-path' } as ProductionWork))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(files(root)).toEqual(before);
  });
});
