import mongoose from 'mongoose';
import type { RequestHandler } from 'express';
import { environment } from '../config/environment.js';

// Compatibility only: existing product routes remain on Mongo until later steps.
export const connectMongo = async (): Promise<void> => {
  if (!environment.mongoUri) {
    console.warn('MONGODB_URI is absent; legacy Mongo-backed routes are unavailable.');
    return;
  }
  await mongoose.connect(environment.mongoUri, { serverSelectionTimeoutMS: 5_000 });
};

export const requireLegacyMongo: RequestHandler = (_request, response, next) => {
  if (mongoose.connection.readyState !== 1) {
    response.status(503).json({ error: 'service_unavailable', message: 'Legacy data service is unavailable.' });
    return;
  }
  next();
};

export const disconnectMongo = async (): Promise<void> => {
  await mongoose.disconnect();
};
