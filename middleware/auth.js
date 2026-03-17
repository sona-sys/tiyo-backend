const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'tiyo-dev-secret-change-in-production';

/**
 * Generates a JWT token for a user.
 * Token contains userId and phone, expires in 30 days.
 */
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, phone: user.phone },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/**
 * Express middleware that verifies JWT from Authorization header.
 * Attaches req.userId on success. Returns 401 on failure.
 *
 * Usage: app.get('/api/protected', requireAuth, handler)
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userPhone = decoded.phone;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { generateToken, requireAuth, JWT_SECRET };
