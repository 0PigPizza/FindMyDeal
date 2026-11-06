const mariadb = require('mariadb');

function createPool() {
  return mariadb.createPool({host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), ...(process.env.DB_SOCKET ? {socketPath: process.env.DB_SOCKET} : {}), user: process.env.DB_USER || 'findmydeal', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'findmydeal', connectionLimit: 5, bigIntAsNumber: true});
}

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS monitors (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, search_term VARCHAR(150) NOT NULL, marketplaces LONGTEXT NOT NULL, min_price DECIMAL(12,2) NULL, max_price DECIMAL(12,2) NULL, location VARCHAR(255) NOT NULL, latitude DECIMAL(10,7) NULL, longitude DECIMAL(10,7) NULL, max_distance INT UNSIGNED NULL, sort_by VARCHAR(20) NOT NULL, interval_seconds INT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query('ALTER TABLE monitors ADD COLUMN IF NOT EXISTS enabled TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN IF NOT EXISTS revision INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS max_items INT UNSIGNED NOT NULL DEFAULT 30');
  await pool.query('ALTER TABLE monitors ADD COLUMN IF NOT EXISTS filter_options LONGTEXT NULL');
}

module.exports = { createPool, init };
