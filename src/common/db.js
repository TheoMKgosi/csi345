const oracledb = require('oracledb');

let pool;

async function initPool(dbConfig) {
  if (pool) return;


  pool = await oracledb.createPool({
    user: "C##myuser",
    password: "password123",
    connectString: "localhost:1521/XE",
    poolMin: 1,
    poolMax: 5,
    poolIncrement: 1,
  });
}

async function withConnection(fn) {
  if (!pool) throw new Error('Oracle pool not initialized');
  const connection = await pool.getConnection();
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

async function query(sql, binds = {}, opts = {}) {
  return withConnection(async (connection) => {
    const result = await connection.execute(sql, binds, {
      autoCommit: opts.autoCommit !== false,
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result.rows || [];
  });
}

async function execute(sql, binds = {}, opts = {}) {
  return withConnection(async (connection) => {
    const result = await connection.execute(sql, binds, {
      autoCommit: opts.autoCommit !== false,
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result;
  });
}

async function transaction(fn) {
  if (!pool) throw new Error('Oracle pool not initialized');
  const connection = await pool.getConnection();
  try {
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      // ignore rollback errors
    }
    throw err;
  } finally {
    await connection.close();
  }
}

async function closePool() {
  if (!pool) return;
  await pool.close(10);
  pool = undefined;
}

module.exports = { initPool, query, execute, transaction, closePool };
