// MongoDB client for Vercel serverless
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { getEnv } from './env';

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

const DB_NAME = 'infracanvas';

export async function getDb(): Promise<Db> {
  if (cachedDb) return cachedDb;

  if (!cachedClient) {
    cachedClient = new MongoClient(getEnv().MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 1,
    });
    await cachedClient.connect();
  }

  cachedDb = cachedClient.db(DB_NAME);
  return cachedDb;
}

export interface UserDocument {
  _id: ObjectId;
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email?: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitHubTokenDocument {
  _id: ObjectId;
  userId: ObjectId;
  accessTokenEncrypted: string;
  tokenType: string;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
}

export { ObjectId };
