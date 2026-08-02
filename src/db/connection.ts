import mongoose from 'mongoose';

export async function connectMongo(uri?: string): Promise<typeof mongoose> {
  const mongoUri =
    uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/auditally';

  mongoose.set('strictQuery', true);

  await mongoose.connect(mongoUri);
  console.log(`[db] connected to MongoDB (${mongoUri.replace(/\/\/.*@/, '//***@')})`);
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
