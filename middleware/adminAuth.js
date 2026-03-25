// Simple admin authentication middleware
// Checks for admin password via query param (?key=xxx) or Authorization header

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tiyo-admin-2026';

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];

  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized — invalid admin key' });
  }

  next();
}

module.exports = { requireAdmin };
