// GitHub token database operations
import { ObjectId } from 'mongodb';
import { getCollection, GitHubTokenDocument } from '../mongodb.js';
import { encrypt, decrypt } from '../encryption.js';

const COLLECTION = 'github_tokens';

export interface SaveTokenInput {
  userId: string | ObjectId;
  accessToken: string;
  tokenType: string;
  scope: string;
}

/**
 * Save or update a GitHub access token for a user
 * Token is encrypted before storage
 */
export async function saveGitHubToken(input: SaveTokenInput): Promise<void> {
  const collection = await getCollection<GitHubTokenDocument>(COLLECTION);
  const userId = typeof input.userId === 'string' ? new ObjectId(input.userId) : input.userId;
  const now = new Date();

  await collection.updateOne(
    { userId },
    {
      $set: {
        accessTokenEncrypted: encrypt(input.accessToken),
        tokenType: input.tokenType,
        scope: input.scope,
        updatedAt: now,
      },
      $setOnInsert: {
        userId,
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

/**
 * Get the decrypted GitHub access token for a user
 */
export async function getGitHubToken(userId: string | ObjectId): Promise<string | null> {
  const collection = await getCollection<GitHubTokenDocument>(COLLECTION);
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;

  const doc = await collection.findOne({ userId: id });

  if (!doc) {
    return null;
  }

  try {
    return decrypt(doc.accessTokenEncrypted);
  } catch (error) {
    console.error('Failed to decrypt GitHub token:', error);
    return null;
  }
}

/**
 * Delete a user's GitHub token
 */
export async function deleteGitHubToken(userId: string | ObjectId): Promise<void> {
  const collection = await getCollection<GitHubTokenDocument>(COLLECTION);
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
  await collection.deleteOne({ userId: id });
}

/**
 * Check if a user has a stored GitHub token
 */
export async function hasGitHubToken(userId: string | ObjectId): Promise<boolean> {
  const collection = await getCollection<GitHubTokenDocument>(COLLECTION);
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
  const count = await collection.countDocuments({ userId: id });
  return count > 0;
}
