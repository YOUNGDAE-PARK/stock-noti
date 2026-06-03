import { admin } from '../../db/storage_sync.js';

/**
 * Express middleware to validate Firebase ID Tokens.
 */
export async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email
    };
    next();
  } catch (err) {
    console.error('[Auth Middleware] Token verification failed:', err.message);
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}
