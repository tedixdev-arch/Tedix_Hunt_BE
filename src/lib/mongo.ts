import mongoose from 'mongoose';
// import { environment } from '../config/environment.js';

export const connectMongo = async (): Promise<void> => {
  const uri = 'mongodb+srv://beersheik:Beer%24heik@cluster0.qyqt3.mongodb.net/tedix_hunt?retryWrites=true&w=majority';//environment.mongoUri;
console.log('Connecting to MongoDB...');
console.log(`MONGODB_URI: ${uri}`);
  if (!uri) {
    console.warn('MONGODB_URI not provided — skipping MongoDB connection.');
    return;
  }

  await mongoose.connect(uri, {
    // use defaults; mongoose 7+ no longer needs options
  } as mongoose.ConnectOptions);

  console.log('Connected to MongoDB');
};

export const disconnectMongo = async (): Promise<void> => {
  await mongoose.disconnect();
};
