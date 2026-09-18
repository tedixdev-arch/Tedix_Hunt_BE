import { describe, expect, it } from 'vitest';
import { findHuntTemplate, listHuntTemplates } from './huntTemplates.js';

describe('approved Hunt template catalog', () => {
  it('contains the expected Signal: Cluj Napoca pilot template', () => {
    expect(findHuntTemplate('signal-cluj-napoca')).toEqual({
      key: 'signal-cluj-napoca',
      version: 1,
      displayName: 'Signal: Cluj Napoca',
      theme: 'Smart Theme (Signal)',
      checkpointNames: [
        'Matthias Rex Statue', 'Stone Gate', 'Clock Tower', 'Fountain Court',
        'Lantern Lane', 'North Passage', 'City Wall · FinishPoint',
      ],
    });
  });

  it('exposes only selectable metadata in the public catalog', () => {
    expect(listHuntTemplates()).toEqual([{
      key: 'signal-cluj-napoca', version: 1,
      displayName: 'Signal: Cluj Napoca', theme: 'Smart Theme (Signal)',
    }]);
  });
});
