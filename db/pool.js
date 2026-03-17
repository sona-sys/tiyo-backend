const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('PostgreSQL connection error:', err.message));

module.exports = pool;
