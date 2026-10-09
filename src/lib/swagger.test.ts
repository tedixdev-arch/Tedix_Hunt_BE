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
