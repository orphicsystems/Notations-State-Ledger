import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { preserveExperiment, EXPERIMENT_TIME } from './fixture';
import { CalibrationAccessService } from './service';
import { runExperiment } from './experiment';
import { POST } from '../app/api/compute/calibration-access/route';
import { GET } from '../app/api/compute/calibration-access/[requestId]/route';
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'calibration-service-')); roots.push(root); return { root, ...preserveExperiment(root) }; }
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it('separates a good synthetic fit from failed held-out tolerance and retains the exact result', () => {
  const { root, request } = fixture(), compute = vi.fn(runExperiment), service = new CalibrationAccessService(root, () => EXPERIMENT_TIME, compute);
  const first = service.submit(request), result = first.receipt.result;
  expect(result.registration.status).toBe('LOCAL_STATIONARY'); expect(result.registration.fit.rmsM!).toBeLessThan(0.002);
  expect(result.heldOutCheck.status).toBe('OUTSIDE_DECLARED_TOLERANCE'); expect(result.fieldAccuracyEstablished).toBe(false);
  expect(result.baseline?.network.confirmed?.lengthM).toBe(24); expect(result.scenario?.network.status).toBe('DISCONNECTED');
  expect(service.submit(request).status).toBe('EXISTING'); expect(compute).toHaveBeenCalledTimes(1);
  const restored = new CalibrationAccessService(root, () => '2030-01-01T00:00:00.000Z', () => { throw new Error('Must not recompute'); }).inspect(request.requestId);
  expect(restored?.receipt).toEqual(first.receipt); expect(restored?.projection.sourceKind).toBe('LOCAL_ANALYSIS');
  const dir = join(root, 'calibration-access', 'receipts'), file = join(dir, readdirSync(dir)[0]), record = JSON.parse(readFileSync(file, 'utf8'));
  record.result.heldOutCheck.status = 'WITHIN_DECLARED_TOLERANCE'; writeFileSync(file, JSON.stringify(record));
  expect(() => service.inspect(request.requestId)).toThrow('failed verification');
});
it('enforces local API access, exact request shape and source-use permissions', async () => {
  const { root, request } = fixture(); vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '1'); vi.stubEnv('PAYLOAD_PRODUCTION_DIR', root);
  const post = (body: unknown, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/compute/calibration-access', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  expect((await POST(post(request, 'https://example.com'))).status).toBe(403);
  expect((await POST(post({ ...request, sourcePath: '/tmp/file' }))).status).toBe(400);
  expect((await POST(post({ ...request, purpose: 'OTHER' }))).status).toBe(403);
  expect((await POST(post(request))).status).toBe(201);
  const loaded = await GET(new Request('http://localhost:3000/api/compute/calibration-access/calibration-access-demo'), { params: Promise.resolve({ requestId: request.requestId }) });
  expect(loaded.status).toBe(200); expect(loaded.headers.get('cache-control')).toBe('no-store');
  vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '0'); expect((await POST(post(request))).status).toBe(403);
});
