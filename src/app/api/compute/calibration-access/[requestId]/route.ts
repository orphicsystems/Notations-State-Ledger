import { requireProductionRequest, productionRoot, productionJson, productionError } from '@/production/http';
import { ProductionError } from '@/production/errors';
import { CalibrationAccessService } from '@/estimation/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    requireProductionRequest(request);
    if (new URL(request.url).search) throw new ProductionError('INVALID_CALIBRATION_QUERY', 'Inspect only an exact saved request id.');
    const result = new CalibrationAccessService(productionRoot()).inspect((await context.params).requestId);
    if (!result) throw new ProductionError('CALIBRATION_NOT_FOUND', 'No saved experiment has this identity.', 404);
    return productionJson(result);
  } catch (error) { return productionError(error); }
}
