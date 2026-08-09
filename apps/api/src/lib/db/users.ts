// User database operations
import { ObjectId } from 'mongodb';
import { getCollection, type UserDocument } from '../mongodb.js';

const COLLECTION = 'users';

export interface CreateUserInput {
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email?: string;
  name?: string;
}

/**
 * Find or create a user by GitHub ID
 * Used during OAuth to ensure user exists
 */
export async function findOrCreateUser(input: CreateUserInput): Promise<UserDocument> {
  const collection = await getCollection<UserDocument>(COLLECTION);
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
    {
      upsert: true,
      returnDocument: 'after',
    }
  );

  if (!result) {
    throw new Error('Failed to find or create user');
  }

  return result;
}

/**
 * Find a user by their internal ID
 */
export async function findUserById(userId: string | ObjectId): Promise<UserDocument | null> {
  const collection = await getCollection<UserDocument>(COLLECTION);
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
  return collection.findOne({ _id: id });
}

/**
 * Find a user by their GitHub ID
 */
export async function findUserByGitHubId(githubId: number): Promise<UserDocument | null> {
  const collection = await getCollection<UserDocument>(COLLECTION);
  return collection.findOne({ githubId });
}

/**
 * Update user profile
 */
export async function updateUser(
  userId: string | ObjectId,
  updates: Partial<Pick<UserDocument, 'githubUsername' | 'githubAvatar' | 'email' | 'name'>>
): Promise<UserDocument | null> {
  const collection = await getCollection<UserDocument>(COLLECTION);
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;

  const result = await collection.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  return result;
}
