import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRegistration } from '../data-os/contracts';
import type { ProductionCommand, ProductionCorpusDefinition, ProductionOutputRef, ProductionRef, ProductionResult, ProductionSourceConfig } from './contracts';
import { runMaintenanceCli } from './maintenance-cli';
import { MAX_MAINTENANCE_BYTES, type MaintenancePlan } from './maintenance';
import { LocalProductionStore } from './store';

let temporary: string;
let root: string;
let requestPath: string;
const purpose = 'CARAVAN_LOCAL_DEVELOPMENT';
const ref = (value: ProductionRef): ProductionRef => ({ id: value.id, digest: value.digest });
const output = (result: ProductionResult, kind: ProductionOutputRef['kind']) => result.run.outputs.find((entry) => entry.kind === kind)!;
const io = () => ({ stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>() });
const planArgs = () => ['plan', '--root', root, '--request', requestPath];
function command<T extends Omit<ProductionCommand, 'schema' | 'requestId'>>(requestId: string, value: T) {
  return { schema: 'payload.production-command.v1', requestId, ...value };
}
function retainRequest() {
  const store = new LocalProductionStore(root, () => '2026-09-06T12:00:00.000Z');
  const definition: ProductionCorpusDefinition = { schema: 'payload.production-corpus-definition.v1', id: 'cli-carrier-corpus', version: '1.0.0',
    domain: 'CARAVAN', recordType: 'Carrier', requiredSubjects: ['Carrier'], requiredFields: ['legalName'],
    coverage: { geography: 'Synthetic CLI scope', temporal: 'One supplied artifact' }, freshness: 'Operator selected',
    evidenceClasses: ['OPERATOR_DECLARATION'], intendedUses: [purpose] };
  const corpus = ref(output(store.execute(command('cli-register-corpus', { kind: 'REGISTER_CORPUS', definition })), 'CORPUS'));
  const policy = JSON.parse(readFileSync('examples/carrier/acquisition.json', 'utf8')).sourceRegistration as SourceRegistration;
  const source: ProductionSourceConfig = { schema: 'payload.production-source-config.v1', id: 'cli-carrier-source', version: '1.0.0', corpus,
    provider: 'Synthetic CLI source', method: 'LOCAL_INLINE_BYTES', adapter: { id: 'caravan.carrier-json/v1', version: '1.0.0' }, supportedCoverage: definition.coverage, policy };
  const sourceRef = ref(output(store.execute(command('cli-register-source', { kind: 'REGISTER_SOURCE', source })), 'SOURCE'));
  const acquired = store.execute(command('cli-capture', { kind: 'ACQUIRE', source: sourceRef, purpose, contentBase64: readFileSync('examples/carrier/source.json').toString('base64') }));
  const target = output(acquired, 'ACQUISITION');
  const normalized = store.execute(command('cli-normalize', { kind: 'NORMALIZE', source: sourceRef, acquisition: ref(target), purpose }));
  expect(normalized.run.state).toBe('COMPLETED');
  const request = { schema: 'payload.maintenance-request.v1', requestId: 'cli-withdrawal', kind: 'WITHDRAWAL', target, replacement: null,
    reason: 'Operator withdrew the synthetic artifact.', runs: [ref(acquired.run), ref(normalized.run)] };
  writeFileSync(requestPath, JSON.stringify(request));
  return { store, normalization: output(normalized, 'NORMALIZATION') };
}
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'payload-maintenance-cli-')); root = join(temporary, 'evidence'); requestPath = join(temporary, 'request.json');
  vi.useFakeTimers(); vi.setSystemTime('2026-09-07T12:00:00.000Z');
});
afterEach(() => { vi.useRealTimers(); rmSync(temporary, { recursive: true, force: true }); });

describe('local maintenance CLI', () => {
  it('plans a real artifact withdrawal, inspects its exact reference, and returns an identical retry', () => {
    const fixture = retainRequest(); const originalRequest = readFileSync(requestPath); const firstIo = io();
    expect(runMaintenanceCli(planArgs(), firstIo)).toBe(0);
    expect(firstIo.stderr).not.toHaveBeenCalled();
    const first = JSON.parse(firstIo.stdout.mock.calls[0][0]) as { status: string; plan: MaintenancePlan };
    expect(first).toMatchObject({ status: 'CREATED', plan: { affected: [{ reference: fixture.normalization, consequence: 'UNSUPPORTED', action: 'REVIEW_NORMALIZATION' }],
      canonicalAdmission: false, releaseActivated: false, executionAuthorized: false } });
    const inspectedIo = io();
    expect(runMaintenanceCli(['inspect', '--digest', first.plan.digest, '--root', root, '--id', first.plan.id], inspectedIo)).toBe(0);
    expect(inspectedIo.stderr).not.toHaveBeenCalled();
    expect(JSON.parse(inspectedIo.stdout.mock.calls[0][0])).toEqual(first.plan);
    vi.setSystemTime('2026-10-01T12:00:00.000Z'); const retryIo = io();
    expect(runMaintenanceCli(planArgs(), retryIo)).toBe(0);
    expect(retryIo.stderr).not.toHaveBeenCalled();
    expect(JSON.parse(retryIo.stdout.mock.calls[0][0])).toEqual({ status: 'EXISTING', plan: first.plan });
    expect(readFileSync(requestPath)).toEqual(originalRequest);
    expect(fixture.store.catalog().runs).toHaveLength(4);
    const mismatchIo = io();
    expect(runMaintenanceCli(['inspect', '--root', root, '--id', first.plan.id, '--digest', `sha256:${'0'.repeat(64)}`], mismatchIo)).toBe(1);
    expect(mismatchIo.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(mismatchIo.stderr.mock.calls[0][0])).toMatchObject({ code: 'MAINTENANCE_REFERENCE_MISMATCH' });
  });

  it('prints help without creating storage', () => {
    const output = io();
    expect(runMaintenanceCli(['--help'], output)).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith(expect.stringContaining('maintenance plan --root'));
    expect(output.stderr).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it.each([
    [], ['delete'], ['plan'], ['inspect'], ['plan', '--root'],
    ['plan', '--root', 'unused', '--root', 'duplicate'],
    ['plan', '--root', 'unused', '--unknown', 'private-value'],
    ['plan', '--root', ' ', '--request', 'unused'],
    ['inspect', '--root', 'unused', '--id', 'plan'],
    ['inspect', '--root', 'unused', '--id', 'plan', '--request', 'unused'],
    ['--help', '--root', 'unused'],
  ].map((args) => ({ args })))('rejects invalid command arguments before creating storage: $args', ({ args }) => {
    const output = io();
    expect(runMaintenanceCli(args, output)).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.mock.calls[0][0])).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(output.stderr.mock.calls[0][0]).not.toContain('private-value');
    expect(existsSync(root)).toBe(false);
  });

  it.each([
    { label: 'malformed JSON', bytes: Buffer.from('{"private-source-secret":'), code: 'MAINTENANCE_UNAVAILABLE' },
    { label: 'invalid UTF-8', bytes: Buffer.from([0xc3, 0x28]), code: 'MAINTENANCE_UNAVAILABLE' },
    { label: 'oversized file', bytes: Buffer.alloc(MAX_MAINTENANCE_BYTES + 1, 32), code: 'MAINTENANCE_UNAVAILABLE' },
    { label: 'invalid request shape', bytes: Buffer.from('{}'), code: 'INVALID_MAINTENANCE_REQUEST' },
  ])('rejects $label without exposing source bytes or filesystem diagnostics', ({ bytes, code }) => {
    writeFileSync(requestPath, bytes); const output = io();
    expect(runMaintenanceCli(planArgs(), output)).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.mock.calls[0][0])).toMatchObject({ code });
    expect(output.stderr.mock.calls[0][0]).not.toContain(temporary);
    expect(output.stderr.mock.calls[0][0]).not.toContain('private-source-secret');
    expect(readFileSync(requestPath)).toEqual(bytes);
    expect(existsSync(root)).toBe(false);
  });

  it('reports a missing request file without creating a maintenance store', () => {
    const output = io();
    expect(runMaintenanceCli(planArgs(), output)).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.mock.calls[0][0])).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(existsSync(root)).toBe(false);
  });

  it('reports a missing plan through stderr without creating a maintenance store', () => {
    const output = io();
    expect(runMaintenanceCli(['inspect', '--root', root, '--id', 'missing-plan', '--digest', `sha256:${'0'.repeat(64)}`], output)).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.mock.calls[0][0])).toMatchObject({ code: 'MAINTENANCE_NOT_FOUND' });
    expect(existsSync(root)).toBe(false);
  });
});
