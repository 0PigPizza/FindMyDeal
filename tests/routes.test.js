const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerRoutes = require('../routes');
const worker = require('../monitor-worker');
const ai = require('../ai-worker');
const alerts = require('../alerts');
const dealFilters = require('../deal-filters');

test('routes use the injected database and current worker', async () => {
  const calls = [];
  const pool = {query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT delay_seconds')) return [{delay_seconds: 30}];
    if (sql.startsWith('DELETE FROM monitors')) return {affectedRows: 1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  let cancelled;
  const app = express();
  app.use(express.json());
  registerRoutes(app, {pool, worker, ai, alerts, dealFilters, getWorker: () => ({cancel: id => { cancelled = id; }})});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const settings = await fetch(`${base}/api/search-settings`);
    assert.deepEqual(await settings.json(), {delaySeconds: 30});
    const removed = await fetch(`${base}/api/monitors/42`, {method: 'DELETE'});
    assert.equal(removed.status, 204);
    assert.equal(cancelled, '42');
    assert.deepEqual(calls[1][1], ['42']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
