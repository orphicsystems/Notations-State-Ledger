import { resolve } from 'node:path';
import { downloadBoreasSlice } from '../src/observations/boreas-source';
const manifest = await downloadBoreasSlice(resolve(process.argv[2] ?? '.payload/boreas-slice'));
console.log(JSON.stringify(manifest, null, 2));
