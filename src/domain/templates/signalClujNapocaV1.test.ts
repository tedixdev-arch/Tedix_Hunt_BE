import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
  signalClujNapocaV1,
} from './signalClujNapocaV1.js';

describe('Signal: Cluj Napoca v1 canonical fixture', () => {
  it('matches the frozen cross-repository checkpoint digest', () => {
    expect(createHash('sha256').update(JSON.stringify(signalClujNapocaV1.checkpoints)).digest('hex'))
      .toBe(SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256);
  });
});
