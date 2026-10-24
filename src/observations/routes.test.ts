import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../app/api/observations/replays/route';
import { GET } from '../app/api/observations/replays/[requestId]/route';
import { syntheticBundle, TEST_TIME } from './fixture';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'replay-http-')); vi.stubEnv('PAYLOAD_PRODUCTION_DIR', root); vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '1'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(TEST_TIME)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const post = (body: unknown, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/observations/replays', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
it('submits and reloads an exact local replay with a separate analysis projection', async () => {
  const { request } = syntheticBundle(root);
  const created = await POST(post(request)); expect(created.status).toBe(201);
  const loaded = await GET(new Request('http://localhost:3000/api/observations/replays/synthetic-replay-1'), { params: Promise.resolve({ requestId: request.requestId }) });
  expect(loaded.status).toBe(200); expect((await loaded.json()).projection.sourceKind).toBe('LOCAL_ANALYSIS'); expect(loaded.headers.get('cache-control')).toBe('no-store');
});
it('enforces local mode, same origin, closed request fields and bounded bodies', async () => {
  const { request } = syntheticBundle(root);
  expect((await POST(post(request, 'https://example.org'))).status).toBe(403);
  expect((await POST(post({ ...request, sourceUrl: 'https://example.org' }))).status).toBe(400);
  expect((await POST(post({ padding: 'x'.repeat(20000) }))).status).toBe(413);
  vi.stubEnv('PAYLOAD_PRODUCTION_LOCAL', '0'); expect((await POST(post(request))).status).toBe(403);
});
