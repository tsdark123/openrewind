import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';
import { scenarioSchema } from '../runner/scenario-types.ts';
import {
  scenarioResultEnvelopeSchema,
  runSummarySchema,
} from '../runner/artifact-types.ts';

function writeSchema(name: string, schema: z.ZodTypeAny, targetPath: string) {
  const jsonSchema = zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none',
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(jsonSchema, null, 2));
  console.log(`Wrote ${targetPath}`);
}

const schemasDir = path.resolve(import.meta.dirname ?? '.', '..', 'schemas');

writeSchema(
  'orion-scenario-v2',
  scenarioSchema,
  path.join(schemasDir, 'orion-scenario-v2.schema.json'),
);

const artifactSchema = z.union([
  scenarioResultEnvelopeSchema,
  z.object({
    type: z.literal('orion.run_summary'),
    version: z.literal('1.0.0'),
    payload: runSummarySchema,
  }),
]);

writeSchema(
  'artifact-v1',
  artifactSchema,
  path.join(schemasDir, 'artifact-v1.schema.json'),
);
