import { exactFields } from '@/data-os/local-record';
import { parseProductionRef } from '@/production/contracts';
import { ProductionError } from '@/production/errors';
import { productionError, productionJson, readProductionBody, requireProductionRequest } from '@/production/http';
import { runProductionWork } from '@/production/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reopen an exact retained plan and verify its dependencies without executing its actions. */
export async function POST(request: Request) {
  try {
    requireProductionRequest(request);
    if (new URL(request.url).search) throw new ProductionError('INVALID_REQUEST', 'Maintenance inspection does not accept query options.');
    const input = await readProductionBody(request, 4096);
    let reference;
    try {
      exactFields(input, ['schema', 'reference']);
      if (input.schema !== 'payload.maintenance-inspection-request.v1') throw new Error();
      reference = parseProductionRef(input.reference);
    } catch {
      throw new ProductionError('INVALID_REQUEST', 'Inspect one exact maintenance plan reference.');
    }
    return productionJson(await runProductionWork({ action: 'INSPECT_MAINTENANCE', reference }));
  } catch (error) { return productionError(error); }
}
