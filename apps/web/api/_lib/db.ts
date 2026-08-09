// Database operations
import { ObjectId } from 'mongodb';
import { getDb, type UserDocument, type GitHubTokenDocument } from './mongodb';
import { encrypt, decrypt } from './encryption';

// Users
export async function findOrCreateUser(input: {
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email?: string;
  name?: string;
}): Promise<UserDocument> {
  const db = await getDb();
  const collection = db.collection<UserDocument>('users');
  const now = new Date();

  const result = await collection.findOneAndUpdate(
    { githubId: input.githubId },
    {
      $set: {
        githubUsername: input.githubUsername,
        githubAvatar: input.githubAvatar,
        email: input.email,
        name: input.name,
        updatedAt: now,
      },
      $setOnInsert: {
        githubId: input.githubId,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) throw new Error('Failed to find or create user');
  return result;
}

export async function findUserById(userId: string): Promise<UserDocument | null> {
  const db = await getDb();
  return db.collection<UserDocument>('users').findOne({ _id: new ObjectId(userId) });
}

// Tokens
export async function saveGitHubToken(input: {
  userId: ObjectId;
  accessToken: string;
  tokenType: string;
  scope: string;
}): Promise<void> {
  const db = await getDb();
  const collection = db.collection<GitHubTokenDocument>('github_tokens');
  const now = new Date();

  await collection.updateOne(
    { userId: input.userId },
    {
      $set: {
        accessTokenEncrypted: encrypt(input.accessToken),
        tokenType: input.tokenType,
        scope: input.scope,
        updatedAt: now,
      },
      $setOnInsert: {
        userId: input.userId,
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

export async function getGitHubToken(userId: string): Promise<string | null> {
  const db = await getDb();
  const doc = await db
    .collection<GitHubTokenDocument>('github_tokens')
    .findOne({ userId: new ObjectId(userId) });

  if (!doc) return null;

  try {
    return decrypt(doc.accessTokenEncrypted);
  } catch {
    return null;
  }
}

export async function hasGitHubToken(userId: string): Promise<boolean> {
  const db = await getDb();
  const count = await db
    .collection<GitHubTokenDocument>('github_tokens')
    .countDocuments({ userId: new ObjectId(userId) });
  return count > 0;
}
