import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment } from '../config/environment.js';
import { connectMongo } from './mongo.js';

describe('Legacy Mongo configuration', () => {
  const original = environment.mongoUri;
  afterEach(() => { environment.mongoUri = original; vi.restoreAllMocks(); });
  it('does not connect without an explicit URI', async () => {
    environment.mongoUri = undefined;
    const connect = vi.spyOn(mongoose, 'connect');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectMongo();
    expect(connect).not.toHaveBeenCalled();
  });
  it('uses only the configured URI', async () => {
    environment.mongoUri = 'mongodb://localhost/legacy_test';
    const connect = vi.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
    await connectMongo();
    expect(connect).toHaveBeenCalledWith(environment.mongoUri, { serverSelectionTimeoutMS: 5000 });
  });
});
