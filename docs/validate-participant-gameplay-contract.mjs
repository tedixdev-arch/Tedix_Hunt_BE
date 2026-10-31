import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import {mechanics, personalMechanics} from '../dist/domain/customExerciseSchemas.js';
const spec=JSON.parse(readFileSync('docs/Participant_Gameplay_Proposed.openapi.json'));
await SwaggerParser.validate(clone(spec));
function clone(x){return structuredClone(x)}
const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});
for(const [name,schema] of Object.entries(spec.components.schemas))ajv.addSchema({...schema,$id:`#/components/schemas/${name}`});
const base='/api/hunts/{id}/checkpoints/{checkpointId}/challenges/{classification}';
for(const e of Object.values(spec.paths[base].get.responses[200].content['application/json'].examples)){
 const value=e.value, validate=ajv.getSchema(`#/components/schemas/Challenge_${value.type}`);
 assert(validate(value),JSON.stringify(validate.errors));
 const injected={...value,answer:{optionId:'secret'}};assert.equal(validate(injected),false);
}
for(const e of Object.values(spec.paths[base+'/attempts'].post.requestBody.content['application/json'].examples)){
 const validate=ajv.getSchema(`#/components/schemas/Submission_${e.value.type}`);
 assert(validate(e.value),JSON.stringify(validate.errors));assert.equal(validate({...e.value,correct:true}),false);
}
assert.equal(Object.keys(spec.components.schemas).filter(k=>k.startsWith('Challenge_')).length,22);
assert.equal(Object.keys(spec.components.schemas).filter(k=>k.startsWith('Submission_')).length,22);
for(const type of Object.keys(mechanics)){
 const dto=spec.components.schemas[`Challenge_${type}`];
 assert.equal(dto.additionalProperties,false);
 for(const field of ['answer','hints','solution','feedback','owner'])assert.equal(field in dto.properties,false);
 assert.equal(dto.properties.interaction.additionalProperties,false);
 const submitted=spec.components.schemas[`Submission_${type}`];
 assert.equal(submitted.additionalProperties,false); assert.equal(submitted.properties.response.additionalProperties,false);
 assert.equal('caseSensitive' in submitted.properties.response.properties,false);
 if(type in personalMechanics)assert.equal(dto.properties.classification.enum[0],'personal');
}
assert(!('facts' in spec.components.schemas['Challenge_distributed-information'].properties.interaction.properties));
assert(!('contributions' in spec.components.schemas['Challenge_shared-final-key'].properties.interaction.properties));
console.log('PASS: OpenAPI syntax/references; 22 closed delivery/submission variants; eight examples; secret/client-authority extra-field rejection. Static contract checks only, no gameplay integration.');
