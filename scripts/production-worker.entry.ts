import { join } from 'node:path';
import { exactFields } from '../src/data-os/local-record';
import { ProductionError } from '../src/production/errors';
import { PRODUCTION_OBJECT_KINDS, parseProductionRef, type ProductionObjectKind } from '../src/production/contracts';
import { LocalProductionStore } from '../src/production/store';
import { compareProductionCandidateBuilds } from '../src/production/comparison';
import { LocalMaintenanceStore } from '../src/production/maintenance';

const limit = 2 * 1024 * 1024;
async function main() {
  if (process.env.PAYLOAD_PRODUCTION_LOCAL !== '1') throw new ProductionError('LOCAL_MODE_DISABLED', 'The local production worker is disabled.', 403);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > limit) throw new ProductionError('BODY_TOO_LARGE', 'Worker input exceeds 2 MiB.', 413);
    chunks.push(chunk);
  }
  let input: Record<string, unknown>;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ProductionError('INVALID_REQUEST', 'Send one valid UTF-8 worker request.'); }
  const root = process.env.PAYLOAD_PRODUCTION_DIR ?? join(process.cwd(), '.payload', 'evidence');
  const store = new LocalProductionStore(root);
  let value: unknown;
  try {
    if (input.schema !== 'payload.production-worker.v1') throw new Error();
    if (input.action === 'EXECUTE') {
      exactFields(input, ['schema', 'action', 'command']);
      value = store.execute(input.command);
    } else if (input.action === 'INSPECT') {
      exactFields(input, ['schema', 'action', 'kind', 'reference']);
      if (!PRODUCTION_OBJECT_KINDS.includes(input.kind as ProductionObjectKind)) throw new Error();
      value = store.inspect(input.kind as ProductionObjectKind, parseProductionRef(input.reference));
    } else if (input.action === 'COMPARE_CANDIDATE_BUILDS') {
      exactFields(input, ['schema', 'action', 'request']);
      value = compareProductionCandidateBuilds(input.request, root);
    } else if (input.action === 'PLAN_MAINTENANCE') {
      exactFields(input, ['schema', 'action', 'request']);
      value = new LocalMaintenanceStore(root).plan(input.request);
    } else if (input.action === 'INSPECT_MAINTENANCE') {
      exactFields(input, ['schema', 'action', 'reference']);
      value = new LocalMaintenanceStore(root).inspect(parseProductionRef(input.reference));
    } else if (input.action === 'CATALOG') {
      exactFields(input, ['schema', 'action']);
      value = store.catalog();
    } else throw new Error();
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    throw new ProductionError('INVALID_REQUEST', 'The production operation is invalid or could not be verified.');
  }
  const output = JSON.stringify({ schema: 'payload.production-worker-result.v1', ok: true, value });
  if (Buffer.byteLength(output) > limit) throw new ProductionError('WORKER_OUTPUT_LIMIT', 'The local result exceeds the output byte limit.', 503);
  process.stdout.write(output);
}
main().catch((error) => {
  const failure = error instanceof ProductionError ? error : new ProductionError('LOCAL_PRODUCTION_UNAVAILABLE',
    'The local operation could not be confirmed. Inspect retained outputs before retrying.', 503);
  process.stdout.write(JSON.stringify({ schema: 'payload.production-worker-result.v1', ok: false,
    error: { code: failure.code, message: failure.message, status: failure.status, details: failure.details } }));
  process.exitCode = 1;
});
