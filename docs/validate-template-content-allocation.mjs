import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';

process.env.JWT_SECRET ??= randomBytes(32).toString('hex');
const { swaggerSpec: spec } = await import('../dist/lib/swagger.js');
// Validate changed schemas separately from the known legacy full-document diagnostics.
const names = ['TemplateLibraryAllocation','CheckpointLibraryAllocations'];
const scoped = { openapi:'3.0.3',info:{title:'Template Content allocation',version:'1'},paths:{},
  components:{schemas:Object.fromEntries(names.map(name=>[name,structuredClone(spec.components.schemas[name])]))} };
await SwaggerParser.validate(scoped);
const ajv = new Ajv({strict:false,allErrors:true,validateFormats:false});
for(const name of names) ajv.addSchema(spec.components.schemas[name],`#/components/schemas/${name}`);
const validate=ajv.getSchema('#/components/schemas/CheckpointLibraryAllocations');
const specific={mode:'specific',contentId:'11111111-1111-4111-8111-111111111111',revisionId:'22222222-2222-4222-8222-222222222222'};
for(const value of [{personal:specific},{team:{mode:'random',filters:{type:'shared-final-key'}}},
  {personal:{...specific,mode:'random',version:1,classification:'personal',type:'single-choice'}}])assert(validate(value),JSON.stringify(validate.errors));
for(const value of [{},{other:specific},{personal:{mode:'specific'}},{personal:{mode:'random',contentId:specific.contentId}},
  {personal:{mode:'random',type:'single-choice'}},{personal:{...specific,filters:{}}},{personal:{mode:'random',filters:{countryCode:'RO'}}}])assert.equal(validate(value),false);
assert.equal(spec.components.schemas.CreatorTemplateContent.properties.checkpoints.items.properties.libraryAllocations.$ref,'#/components/schemas/CheckpointLibraryAllocations');
console.log('PASS: allocation OpenAPI syntax/references, Specific/Random examples, closed fields and identity-pair requirements.');
