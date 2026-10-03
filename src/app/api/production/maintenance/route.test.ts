import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionError } from '@/production/errors';
import { MAX_MAINTENANCE_BYTES } from '@/production/maintenance';
import { POST } from './route';

const worker = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/production/worker', () => ({ runProductionWork: worker.run }));
const local = 'http://127.0.0.1:3000/api/production/maintenance';
const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
  'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const change = { schema: 'payload.maintenance-request.v1', requestId: 'maintenance-1', kind: 'CORRECTION',
  target: { kind: 'ACQUISITION', id: 'capture-before', digest: digest('a') },
  replacement: { kind: 'ACQUISITION', id: 'capture-after', digest: digest('b') },
  reason: 'Review the declared corrected source artifact.',
  runs: [{ id: 'run-b', digest: digest('c') }, { id: 'run-a', digest: digest('d') }] };
const result = { status: 'CREATED', plan: { schema: 'payload.maintenance-plan.v1', id: change.requestId,
  executionAuthorized: false, canonicalAdmission: false, affected: [] } };
const request = (value: unknown = change, changes: Record<string, string> = {}, url = local) =>
  new Request(url, { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify(value) });
function boundary(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-payload-production')).toBe('local-development-v1');
}
async function refusal(input: Request, code: string, status = 400) {
  const response = await POST(input);
  expect(response.status).toBe(status); boundary(response);
  expect(await response.json()).toMatchObject({ schema: 'payload.production-error.v1', canonicalAdmission: false, error: { code } });
  expect(worker.run).not.toHaveBeenCalled();
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '1'); worker.run.mockResolvedValue(result); });
afterEach(() => vi.unstubAllEnvs());

describe('maintenance planning HTTP boundary', () => {
  it('dispatches the parsed exact request and returns the worker result unchanged', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); boundary(response);
    expect(await response.json()).toEqual(result);
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(worker.run).toHaveBeenCalledWith({ action: 'PLAN_MAINTENANCE', request: { ...change, runs: [...change.runs].reverse() } });
  });
  it('requires explicit local mode before reading a body', async () => {
    vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '0');
    const input = request(); const reader = vi.spyOn(input.body!, 'getReader');
    await refusal(input, 'LOCAL_MODE_DISABLED', 403); expect(reader).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }])('requires the same loopback origin (%j)', async (changes) => {
    const input = request(change, changes); const reader = vi.spyOn(input.body!, 'getReader');
    await refusal(input, 'LOCAL_ONLY', 403); expect(reader).not.toHaveBeenCalled();
  });
  it('refuses query options before reading a body', async () => {
    const input = request(change, {}, `${local}?root=private-path`); const reader = vi.spyOn(input.body!, 'getReader');
    await refusal(input, 'INVALID_REQUEST'); expect(reader).not.toHaveBeenCalled();
  });
  it.each(['root', 'path', 'plannedAt', 'execute', 'canonicalAdmission', 'dependencies'])('rejects caller-supplied %s', async (field) => {
    await refusal(request({ ...change, [field]: 'untrusted' }), 'INVALID_MAINTENANCE_REQUEST');
  });
  it.each([
    { ...change, target: { ...change.target, digest: 'sha256:short' } },
    { ...change, replacement: null },
    { ...change, kind: 'WITHDRAWAL' },
    { ...change, runs: [] },
    { ...change, runs: [change.runs[0], change.runs[0]] },
  ])('rejects malformed exact reference/change contracts (%j)', async (value) => {
    await refusal(request(value), 'INVALID_MAINTENANCE_REQUEST');
  });
  it('accepts withdrawal only with an explicit null replacement', async () => {
    const response = await POST(request({ ...change, kind: 'WITHDRAWAL', replacement: null }));
    expect(response.status).toBe(200);
    expect(worker.run).toHaveBeenCalledWith({ action: 'PLAN_MAINTENANCE', request: { ...change, kind: 'WITHDRAWAL', replacement: null, runs: [...change.runs].reverse() } });
  });
  it('bounds streamed bytes even when content-length understates them', async () => {
    const input = new Request(local, { method: 'POST', headers: { ...headers, 'content-length': '1' },
      body: JSON.stringify(change).padEnd(MAX_MAINTENANCE_BYTES + 1, ' ') });
    await refusal(input, 'BODY_TOO_LARGE', 413);
  });
  it('rejects unsupported media types and malformed JSON before dispatch', async () => {
    await refusal(request(change, { 'content-type': 'text/plain' }), 'INVALID_CONTENT_TYPE', 415);
    await refusal(new Request(local, { method: 'POST', headers, body: '{' }), 'INVALID_REQUEST');
  });
  it('preserves known backend integrity failures', async () => {
    worker.run.mockRejectedValueOnce(new ProductionError('MAINTENANCE_INTEGRITY_FAILED', 'Retained dependencies did not verify.', 409));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'MAINTENANCE_INTEGRITY_FAILED' } });
  });
  it('redacts unexpected worker errors', async () => {
    worker.run.mockRejectedValueOnce(new Error('private-path/SECRET'));
    const response = await POST(request());
    expect(response.status).toBe(503); boundary(response);
    const body = await response.json();
    expect(body.error.code).toBe('LOCAL_PRODUCTION_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/private-path|SECRET/);
  });
});
