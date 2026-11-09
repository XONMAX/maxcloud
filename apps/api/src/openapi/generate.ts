/* Writes docs/openapi.json (pnpm openapi). */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSpec } from './spec';

const out = resolve(__dirname, '../../../../docs/openapi.json');
writeFileSync(out, JSON.stringify(buildSpec(), null, 2) + '\n');
console.log(`wrote ${out}`);
