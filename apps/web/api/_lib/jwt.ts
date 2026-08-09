// JWT session management
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getEnv } from './env';

export interface SessionPayload extends JWTPayload {
  userId: string;
  githubId: number;
  githubUsername: string;
}

export async function createSessionToken(payload: {
  userId: string;
  githubId: number;
  githubUsername: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(getEnv().JWT_SECRET);

  return new SignJWT({
    userId: payload.userId,
    githubId: payload.githubId,
    githubUsername: payload.githubUsername,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('infracanvas')
    .setAudience('infracanvas-web')
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secret = new TextEncoder().encode(getEnv().JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'infracanvas',
      audience: 'infracanvas-web',
    });

    if (
      typeof payload.userId !== 'string' ||
      typeof payload.githubId !== 'number' ||
      typeof payload.githubUsername !== 'string'
    ) {
      return null;
    }

    return payload as SessionPayload;
  } catch {
    return null;
  }
}
