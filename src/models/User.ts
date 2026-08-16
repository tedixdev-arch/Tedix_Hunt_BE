import mongoose from 'mongoose';

export type Role = 'creator' | 'participant' | 'guest';

export interface IUser extends mongoose.Document {
  email?: string;
  passwordHash?: string;
  role: Role;
  name?: string;
  organizations?: mongoose.Types.ObjectId[];
  isGuest?: boolean;
  tedixUserId?: string;
  createdAt: Date;
}

const schema = new mongoose.Schema<IUser>({
  email: { type: String, index: true, sparse: true },
  passwordHash: { type: String },
  role: { type: String, required: true },
  name: { type: String },
  organizations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Organization' }],
  isGuest: { type: Boolean, default: false },
  tedixUserId: { type: String, index: true, sparse: true },
  createdAt: { type: Date, default: () => new Date() },
});

export const User = mongoose.model<IUser>('User', schema);
