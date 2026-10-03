import { MAX_MAINTENANCE_BYTES, parseMaintenanceRequest } from '@/production/maintenance';
import { ProductionError } from '@/production/errors';
import { productionError, productionJson, readProductionBody, requireProductionRequest } from '@/production/http';
import { runProductionWork } from '@/production/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Retain a review plan for exact production artifacts; no execution or canonical retraction. */
export async function POST(request: Request) {
  try {
    requireProductionRequest(request);
    if (new URL(request.url).search) throw new ProductionError('INVALID_REQUEST', 'Maintenance planning does not accept query options.');
    const input = parseMaintenanceRequest(await readProductionBody(request, MAX_MAINTENANCE_BYTES));
    return productionJson(await runProductionWork({ action: 'PLAN_MAINTENANCE', request: input }));
  } catch (error) { return productionError(error); }
}
