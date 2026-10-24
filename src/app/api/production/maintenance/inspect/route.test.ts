import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionError } from '@/production/errors';
import { POST } from './route';

const worker = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/production/worker', () => ({ runProductionWork: worker.run }));
const local = 'http://127.0.0.1:3000/api/production/maintenance/inspect';
const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
  'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const input = { schema: 'payload.maintenance-inspection-request.v1', reference: { id: 'maintenance-1', digest: `sha256:${'a'.repeat(64)}` } };
const plan = { schema: 'payload.maintenance-plan.v1', id: input.reference.id, executionAuthorized: false };
const request = (value: unknown = input, changes: Record<string, string> = {}, url = local) =>
  new Request(url, { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify(value) });
async function refusal(value: Request, code: string, status = 400) {
  const response = await POST(value);
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ schema: 'payload.production-error.v1', canonicalAdmission: false, error: { code } });
  expect(worker.run).not.toHaveBeenCalled();
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '1'); worker.run.mockResolvedValue(plan); });
afterEach(() => vi.unstubAllEnvs());

describe('maintenance inspection HTTP boundary', () => {
  it('dispatches only the exact plan reference and returns the result unchanged', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(plan);
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(worker.run).toHaveBeenCalledWith({ action: 'INSPECT_MAINTENANCE', reference: input.reference });
  });
  it('requires local mode before reading the body', async () => {
    vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '0');
    const value = request(); const reader = vi.spyOn(value.body!, 'getReader');
    await refusal(value, 'LOCAL_MODE_DISABLED', 403); expect(reader).not.toHaveBeenCalled();
  });
  it('requires same-loopback-origin access before reading the body', async () => {
    const value = request(input, { origin: 'https://evil.example' }); const reader = vi.spyOn(value.body!, 'getReader');
    await refusal(value, 'LOCAL_ONLY', 403); expect(reader).not.toHaveBeenCalled();
  });
  it('rejects query parameters before reading the body', async () => {
    const value = request(input, {}, `${local}?latest=true`); const reader = vi.spyOn(value.body!, 'getReader');
    await refusal(value, 'INVALID_REQUEST'); expect(reader).not.toHaveBeenCalled();
  });
  it.each([
    null, {}, { ...input, schema: 'payload.maintenance-inspection-request.v2' },
    { ...input, reference: { id: input.reference.id } },
    { ...input, reference: { ...input.reference, digest: 'sha256:short' } },
    { ...input, reference: { ...input.reference, path: 'private-path' } },
    { ...input, reference: { ...input.reference, id: '../private-path' } },
    { ...input, root: 'private-path' }, { ...input, execute: true },
  ])('rejects malformed or extended references (%j)', async (value) => {
    await refusal(request(value), 'INVALID_REQUEST');
  });
  it('bounds inspection bodies to 4096 bytes regardless of content-length', async () => {
    await refusal(new Request(local, { method: 'POST', headers: { ...headers, 'content-length': '1' },
      body: JSON.stringify(input).padEnd(4097, ' ') }), 'BODY_TOO_LARGE', 413);
  });
  it('preserves backend-authored inspection errors', async () => {
    worker.run.mockRejectedValueOnce(new ProductionError('MAINTENANCE_NOT_FOUND', 'The plan is not retained.', 404));
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'MAINTENANCE_NOT_FOUND' } });
  });
  it('redacts unexpected worker errors as unavailable rather than malformed input', async () => {
    worker.run.mockRejectedValueOnce(new Error('private-path/SECRET'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('LOCAL_PRODUCTION_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/private-path|SECRET/);
  });
});
