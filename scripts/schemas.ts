import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { CreateWorkInputSchema, WorkContractSchema, HandoffPackageSchema, VerificationReceiptSchema, WorkRecordSchema, PortableStateSchema } from '../packages/contracts/src/index.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({ 'create-work': CreateWorkInputSchema, 'work-contract': WorkContractSchema, handoff: HandoffPackageSchema, 'verification-receipt': VerificationReceiptSchema, 'work-record': WorkRecordSchema, 'portable-state': PortableStateSchema })) {
  await writeFile(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2) + '\n');
}
