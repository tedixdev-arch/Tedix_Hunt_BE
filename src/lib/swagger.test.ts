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
