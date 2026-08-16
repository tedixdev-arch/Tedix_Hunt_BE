import mongoose from 'mongoose';

export interface IRefreshToken extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

const schema = new mongoose.Schema<IRefreshToken>({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

export const RefreshToken = mongoose.model<IRefreshToken>('RefreshToken', schema);
