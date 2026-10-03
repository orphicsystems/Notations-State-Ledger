import { basename, dirname, resolve } from 'node:path';
import { readImmutableFile } from '../data-os/local-files';
import { ProductionError } from './errors';
import { LocalMaintenanceStore, MAX_MAINTENANCE_BYTES } from './maintenance';

const usage = 'maintenance plan --root <evidence-directory> --request <request.json> | maintenance inspect --root <evidence-directory> --id <plan-id> --digest <sha256:...>';
export function runMaintenanceCli(args: string[], io: { stdout: (text: string) => void; stderr: (text: string) => void }): number {
  try {
    if (args.length === 1 && args[0] === '--help') { io.stdout(usage); return 0; }
    const [command, ...flags] = args;
    const allowed = command === 'plan' ? ['--root', '--request'] : command === 'inspect' ? ['--root', '--id', '--digest'] : [];
    if (!allowed.length || flags.length !== allowed.length * 2) throw new ProductionError('INVALID_REQUEST', usage);
    const options: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!allowed.includes(flags[i]) || Object.hasOwn(options, flags[i]) || !flags[i + 1]?.trim()) throw new ProductionError('INVALID_REQUEST', usage);
      options[flags[i]] = flags[i + 1];
    }
    const store = new LocalMaintenanceStore(options['--root']);
    let result: unknown;
    if (command === 'plan') {
      const path = resolve(options['--request']);
      const bytes = readImmutableFile(dirname(path), [basename(path)], MAX_MAINTENANCE_BYTES);
      if (!bytes) throw new ProductionError('INVALID_REQUEST', 'The maintenance request file was not found.');
      result = store.plan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } else result = store.inspect({ id: options['--id'], digest: options['--digest'] });
    io.stdout(JSON.stringify(result, null, 2)); return 0;
  } catch (error) {
    const failure = error instanceof ProductionError ? error : new ProductionError('MAINTENANCE_UNAVAILABLE', 'The local maintenance operation could not be verified. Existing evidence was preserved.', 503);
    io.stderr(JSON.stringify({ code: failure.code, message: failure.message })); return 1;
  }
}
