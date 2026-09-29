import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listApproved: vi.fn(),
  findApproved: vi.fn(),
}));

vi.mock('../models/HuntTemplate.js', () => ({ HuntTemplates: {
  listApprovedWithLatestVersion: mocks.listApproved,
  findApprovedByKeyWithLatestVersion: mocks.findApproved,
} }));

import {
  findApprovedHuntTemplate,
  listApprovedHuntTemplates,
} from './huntTemplates.js';

describe('approved Hunt template catalog', () => {
  it('maps persisted content to the existing public metadata contract', async () => {
    mocks.listApproved.mockResolvedValue([{
      key: 'signal-cluj-napoca', version: 1,
      content: { displayName: 'Persisted Signal name', theme: 'Persisted theme' },
    }]);
    await expect(listApprovedHuntTemplates()).resolves.toEqual([{
      key: 'signal-cluj-napoca', version: 1,
      displayName: 'Persisted Signal name', theme: 'Persisted theme',
    }]);
  });

  it('returns repository misses without a legacy fallback', async () => {
    mocks.findApproved.mockResolvedValue(null);
    await expect(findApprovedHuntTemplate('signal-cluj-napoca')).resolves.toBeNull();
  });
});
