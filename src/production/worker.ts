import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ProductionError } from './errors';

export const PRODUCTION_WORKER_TIMEOUT_MS = 15_000;
export const MAX_PRODUCTION_WORKER_BYTES = 2 * 1024 * 1024;
export const MAX_PRODUCTION_WORKERS = 2;
let active = 0;

export type ProductionWork = { action: 'EXECUTE'; command: unknown }
  | { action: 'INSPECT'; kind: string; reference: unknown }
  | { action: 'COMPARE_CANDIDATE_BUILDS'; request: unknown }
  | { action: 'PLAN_MAINTENANCE'; request: unknown }
  | { action: 'INSPECT_MAINTENANCE'; reference: unknown }
  | { action: 'CATALOG' };

/** Fixed Node entry point. A caller supplies an operation, never executable options or paths. */
export function runProductionWork(work: ProductionWork): Promise<unknown> {
  const input = JSON.stringify({ schema: 'payload.production-worker.v1', ...work });
  if (Buffer.byteLength(input) > MAX_PRODUCTION_WORKER_BYTES) throw new ProductionError('BODY_TOO_LARGE', 'The worker request exceeds 2 MiB.', 413);
  if (active >= MAX_PRODUCTION_WORKERS) throw new ProductionError('PRODUCTION_BUSY', 'The local production worker limit is occupied. Retry the same request.', 503);
  active += 1;
  return new Promise((resolve, reject) => {
    const executable = process.execPath;
    const entry = join(process.cwd(), '.stamp', 'production-worker.mjs');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [entry], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PAYLOAD_PRODUCTION_LOCAL: process.env.PAYLOAD_PRODUCTION_LOCAL ?? '0' } });
    } catch {
      active -= 1;
      reject(new ProductionError('WORKER_UNAVAILABLE', 'The local worker could not be started. Build it with npm run production:build.', 503));
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    let exited = false;
    const settle = (error?: ProductionError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(value);
    };
    // Reserve the concurrency slot until the child actually exits, including after timeout.
    const release = () => { if (!exited) { exited = true; active -= 1; } };
    const unavailable = () => new ProductionError('WORKER_UNAVAILABLE', 'The local worker could not complete. Build it with npm run production:build; inspect retained outputs before retrying.', 503);
    const timer = setTimeout(() => settle(new ProductionError('EXECUTION_TIMEOUT',
      'The local operation exceeded 15 seconds. Completion is unconfirmed; retry the identical request to discover retained outputs without repeating incomplete work.', 504)), PRODUCTION_WORKER_TIMEOUT_MS);
    child.on('error', () => { release(); settle(unavailable()); });
    child.stdin!.on('error', () => settle(unavailable()));
    child.stdout!.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_PRODUCTION_WORKER_BYTES) settle(new ProductionError('WORKER_OUTPUT_LIMIT', 'The local result exceeded its output limit. Inspect the request before retrying.', 503));
      else chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_PRODUCTION_WORKER_BYTES) settle(unavailable());
    });
    child.on('close', (code) => {
      release();
      if (settled) return;
      try {
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (code === 0 && result.schema === 'payload.production-worker-result.v1' && result.ok === true && result.value && typeof result.value === 'object') {
          settle(undefined, result.value); return;
        }
        if (code === 1 && result.schema === 'payload.production-worker-result.v1' && result.ok === false &&
          /^[A-Z_]{1,80}$/.test(result.error?.code) && typeof result.error?.message === 'string' && result.error.message.length <= 512 &&
          Number.isSafeInteger(result.error?.status) && result.error.status >= 400 && result.error.status <= 599) {
          settle(new ProductionError(result.error.code, result.error.message, result.error.status, result.error.details)); return;
        }
      } catch { /* Never return arbitrary process diagnostics. */ }
      settle(unavailable());
    });
    child.stdin!.end(input);
  });
}
