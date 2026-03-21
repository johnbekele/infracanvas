// MongoDB client with connection pooling
import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { env } from './env.js';

// Singleton client for connection pooling
let client: MongoClient | null = null;
let db: Db | null = null;

const DB_NAME = 'infracanvas';

/**
 * Get or create the MongoDB client
 * Uses connection pooling for serverless environments
 */
export async function getClient(): Promise<MongoClient> {
  if (client) {
    return client;
  }

  client = new MongoClient(env().MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    maxIdleTimeMS: 60000,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  return client;
}

/**
 * Get the database instance
 */
export async function getDb(): Promise<Db> {
  if (db) {
    return db;
  }

  const mongoClient = await getClient();
  db = mongoClient.db(DB_NAME);

  // Ensure indexes on first connection
  await ensureIndexes(db);

  return db;
}

/**
 * Get a typed collection
 */
export async function getCollection<T extends object>(
  name: string
): Promise<Collection<T>> {
  const database = await getDb();
  return database.collection<T>(name);
}

/**
 * Ensure required indexes exist
 */
async function ensureIndexes(database: Db): Promise<void> {
  // Users collection
  const users = database.collection('users');
  await users.createIndex({ githubId: 1 }, { unique: true });
  await users.createIndex({ githubUsername: 1 });

  // GitHub tokens collection
  const tokens = database.collection('github_tokens');
  await tokens.createIndex({ userId: 1 }, { unique: true });

  // Sessions collection
  const sessions = database.collection('sessions');
  await sessions.createIndex({ userId: 1 });
  await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // AWS connections collection
  const awsConnections = database.collection('aws_connections');
  await awsConnections.createIndex({ userId: 1 });

  // Designs collection
  const designs = database.collection('designs');
  await designs.createIndex({ userId: 1 });
  await designs.createIndex({ updatedAt: -1 });
}

/**
 * Close the MongoDB connection
 * Useful for graceful shutdown
 */
export async function closeConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// Collection types
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

export interface SessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

export interface AWSConnectionDocument {
  _id: ObjectId;
  userId: ObjectId;
  roleArn: string;
  externalId: string;
  region: string;
  codeBuildProject?: string;
  webhookSecret?: string;
  status: 'pending' | 'active' | 'error';
  lastValidated?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DesignDocument {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

// Re-export ObjectId for convenience
export { ObjectId };
