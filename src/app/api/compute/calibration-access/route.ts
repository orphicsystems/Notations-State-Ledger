import { requireProductionRequest, readProductionBody, productionRoot, productionJson, productionError } from '@/production/http';
import { CalibrationAccessService } from '@/estimation/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { requireProductionRequest(request); const result = new CalibrationAccessService(productionRoot()).submit(await readProductionBody(request, 8192)); return productionJson(result, result.status === 'CREATED' ? 201 : 200); }
  catch (error) { return productionError(error); }
}
