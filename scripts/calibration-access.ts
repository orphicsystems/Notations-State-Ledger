import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { calibrationAccessFixture } from '../src/estimation/fixture';
const root = resolve(process.argv[2] ?? '.payload/calibration-access'), output = resolve(process.argv[3] ?? '.payload/calibration-access-artifacts');
const fixture = calibrationAccessFixture(root); mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries(fixture)) writeFileSync(join(output, `${name}.json`), JSON.stringify(value, null, 2));
const result = fixture.analysis.receipt.result;
console.log(JSON.stringify({ output, registration: result.registration.status, fitRmsM: result.registration.fit.rmsM, heldOut: result.heldOutCheck, straightLineM: result.baseline?.euclidean.distanceM, walkingM: result.baseline?.network.confirmed?.lengthM, closedPassage: result.scenario?.network.status }, null, 2));
