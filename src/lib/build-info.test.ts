import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
import { readBuildRevision } from './build-info.js';

beforeEach(() => { mocks.read.mockReset(); });
it('reads a full commit SHA from the build artifact', () => {
  mocks.read.mockReturnValue('b'.repeat(40) + '\n');
  expect(readBuildRevision()).toBe('b'.repeat(40));
});
it('does not report malformed metadata as a revision', () => {
  mocks.read.mockReturnValue('unexpected content');
  expect(readBuildRevision()).toBeNull();
});
it('reports an unknown revision for local builds without metadata', () => {
  mocks.read.mockImplementation(() => { throw new Error('File missing'); });
  expect(readBuildRevision()).toBeNull();
});
