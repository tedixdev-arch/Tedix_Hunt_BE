import { describe, expect, it } from 'vitest';
import { listStarterCatalog, orderStarterCatalog, type StarterCatalogItem } from './starterCatalog.js';
import { signalClujNapocaV1 } from './signalClujNapocaV1.js';
import { signalOverloadClujNapocaV1 } from './signalOverloadClujNapocaV1.js';
import { createSignalClujNapocaStarter } from './signalClujNapocaStarter.js';
import { createSignalOverloadClujNapocaStarter } from './signalOverloadClujNapocaStarter.js';

// Synthetic dates exercise ordering only; they are never catalog metadata.
const item = (key: string, createdAt: string | null): StarterCatalogItem => ({
  key, createdAt, displayName: key, description: 'Fixture', creationPath: `/fixture/${key}`,
});

describe('starter catalog', () => {
  it('uses both actual identities and leaves unavailable timestamps null', () => {
    const items = listStarterCatalog();
    expect(items).toHaveLength(2);
    [signalClujNapocaV1, signalOverloadClujNapocaV1].forEach((source, index) => {
      expect(items[index]).toMatchObject({ key: source.key, displayName: source.displayName,
        createdAt: null, creationPath: `/api/creator/templates/starters/${source.key}` });
      expect(items[index].description.length).toBeGreaterThan(0);
    });
  });

  it('sorts by instant newest first with unknown dates last without mutating input', () => {
    const input = [item('unknown', null), item('older', '2000-01-01T00:00:00Z'),
      item('newer', '2001-01-01T00:00:00Z')];
    const before = structuredClone(input);
    expect(orderStarterCatalog(input).map(({ key }) => key)).toEqual(['newer', 'older', 'unknown']);
    expect(input).toEqual(before);
  });

  it.each([null, '2000-01-01T00:00:00Z'])('orders ties deterministically for %s', (date) => {
    const input = [item('z', date), item('a', date), item('m', date)];
    expect(orderStarterCatalog(input).map(({ key }) => key)).toEqual(['a', 'm', 'z']);
    expect(orderStarterCatalog(input.reverse()).map(({ key }) => key)).toEqual(['a', 'm', 'z']);
  });

  it('uses the key for equal instants with different timezone representations', () => {
    expect(orderStarterCatalog([item('z', '2000-01-01T00:00:00Z'),
      item('a', '2000-01-01T02:00:00+02:00')]).map(({ key }) => key)).toEqual(['a', 'z']);
  });

  it('isolates results and preserves canonical content and starter snapshots', () => {
    const before = structuredClone([signalClujNapocaV1, signalOverloadClujNapocaV1]);
    const drafts = [createSignalClujNapocaStarter('existing-one'), createSignalOverloadClujNapocaStarter('existing-two')];
    const snapshots = structuredClone(drafts);
    const result = listStarterCatalog();
    result[0].displayName = 'Changed';
    result[0].createdAt = '2000-01-01T00:00:00Z';
    result.pop();
    expect(listStarterCatalog()).toHaveLength(2);
    expect(listStarterCatalog()[0]).toMatchObject({ displayName: 'Signal: Cluj Napoca', createdAt: null });
    expect([signalClujNapocaV1, signalOverloadClujNapocaV1]).toEqual(before);
    expect(drafts).toEqual(snapshots);
    expect([createSignalClujNapocaStarter('existing-one'), createSignalOverloadClujNapocaStarter('existing-two')]).toEqual(snapshots);
  });
});
