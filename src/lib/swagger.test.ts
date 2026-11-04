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
