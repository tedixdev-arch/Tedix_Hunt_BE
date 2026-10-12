import { describe, expect, it } from 'vitest';
import { swaggerSpec } from './swagger.js';

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
