import { describe, expect, it } from 'vitest';
import { swaggerSpec } from './swagger.js';

it('documents the authenticated nullable-date starter collection and preserves POST contracts', () => {
  const spec = swaggerSpec as any;
  const get = spec.paths['/api/creator/templates/starters'].get;
  expect(get.security).toEqual([{ bearerAuth: [] }]);
  expect(get.responses).toHaveProperty('401');
  expect(get.responses).toHaveProperty('403');
  const schema = get.responses['200'].content['application/json'].schema;
  expect(schema.required).toEqual(['items']);
  expect(schema.properties.items.items.required).toEqual(['key', 'displayName', 'description', 'createdAt', 'creationPath']);
  expect(schema.properties.items.items.properties.createdAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
  for (const key of ['signal-cluj-napoca', 'signal-overload-cluj-napoca']) {
    expect(spec.paths[`/api/creator/templates/starters/${key}`].post.responses).toHaveProperty('201');
  }
});

describe('Swagger reward contract', () => {
  it('keeps reward kinds independent of checkpoint challenge types', () => {
    expect(swaggerSpec).toHaveProperty(
      'components.schemas.RewardDetails.properties.kind',
      { type: 'string', enum: ['physical', 'virtual'] },
    );
  });
});


it('documents Creator draft deletion alongside the existing read', () => {
  expect(swaggerSpec).toHaveProperty('paths./api/creator/templates/{key}.get');
  expect(swaggerSpec).toHaveProperty('paths./api/creator/templates/{key}.delete.responses.204');
  expect(swaggerSpec).toHaveProperty('paths./api/creator/templates/{key}.delete.responses.409');
});

it.each(['login', 'register'])('documents disabled Tedix authentication for participant %s', (endpoint) => {
  const spec = swaggerSpec as any;
  const operation = spec.paths[`/api/auth/participant/${endpoint}`].post;
  expect(operation.description).toContain('disabled');
  expect(operation.requestBody.content['application/json'].schema.properties).not.toHaveProperty('tedixUserId');
  expect(operation.responses['401'].description).toContain('no account details or tokens');
});

it('documents exact Content revision review, independent authorization, feedback and compatible Creator discovery', () => {
  const spec=swaggerSpec as any;
  for(const path of [
    '/api/creator/content/{id}/revisions/{revisionId}/submit',
    '/api/admin/content/review/{id}/revisions/{revisionId}/approve',
    '/api/admin/content/review/{id}/revisions/{revisionId}/request-changes',
  ]) {
    const operation=spec.paths[path].post;
    expect(operation.security).toEqual([{bearerAuth:[]}]);
    expect(operation.parameters.map((p:any)=>p.name)).toEqual(['id','revisionId']);
    expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
    expect(operation.responses).toHaveProperty('409');
  }
  expect(spec.paths['/api/admin/content/review/{id}/revisions/{revisionId}'].get).toBeTruthy();
  expect(spec.paths['/api/admin/content/review'].get.parameters.map((p:any)=>p.name)).toEqual(['limit','after']);
  expect(spec.paths['/api/admin/content/review/{id}/revisions/{revisionId}/request-changes'].post.requestBody.content['application/json'].schema.required).toEqual(['comment']);
  expect(spec.paths['/api/creator/content'].get.parameters.find((p:any)=>p.name==='view').schema.enum).toEqual(['all']);
  expect(spec.components.schemas.LibraryContent.properties.reviewEvents.items.$ref).toBe('#/components/schemas/LibraryReviewEvent');
});

it('documents approved discovery, every supported mechanic, exact detail and bounded optional filters', () => {
 const spec=swaggerSpec as any;
 const list=spec.paths['/api/creator/content/approved'].get;
 const detail=spec.paths['/api/creator/content/approved/{contentId}/revisions/{revisionId}'].get;
 for(const operation of [list,detail]) expect(operation.security).toEqual([{bearerAuth:[]}]);
 expect(list.parameters.map((p:any)=>p.name)).toEqual(['limit','after','classification','type','category','grade','q','countryCode','admin1Code','geographicId']);
 expect(list.parameters.every((p:any)=>!p.required)).toBe(true);
 expect(list.parameters.find((p:any)=>p.name==='limit').schema.maximum).toBe(100);
 const canonical=spec.components.schemas.LibraryExercise.oneOf.map((s:any)=>s.properties.type.enum[0]).sort();
 expect(list.parameters.find((p:any)=>p.name==='type').schema.enum.toSorted()).toEqual(canonical);
 expect(spec.components.schemas.ApprovedLibraryMetadata.properties.type.enum.toSorted()).toEqual(canonical);
 expect(spec.components.schemas.ApprovedLibraryMetadata.properties).not.toHaveProperty('exercise');
 expect(spec.components.schemas.ApprovedLibraryMetadata.properties).not.toHaveProperty('ownerId');
 expect(detail.parameters.map((p:any)=>p.name)).toEqual(['contentId','revisionId']);
 expect(detail.responses).toHaveProperty('404');
 expect(spec.components.schemas.ApprovedLibraryDetail.allOf[1].properties.exercise.$ref).toBe('#/components/schemas/LibraryExercise');
});
