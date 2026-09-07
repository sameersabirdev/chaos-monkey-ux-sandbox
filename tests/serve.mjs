#!/usr/bin/env node
/**
 * serve.mjs — tiny static + API server for the test fixtures. No dependencies.
 *
 * Usage: node tests/serve.mjs [--port 4173] [--app broken|fixed]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const PORT = +arg('--port', '4173');
const APP = arg('--app', 'broken');
const HERE = import.meta.dirname;

const html = fs.readFileSync(path.join(HERE, 'fixtures', `${APP}-app.html`), 'utf8');

const rows = Array.from({ length: 25 }, (_, i) => ({
  id: i,
  name: `Item ${i}`,
  value: (i + 1) * 100,
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ data: rows, items: rows, total: rows.length }));
  }
  if (url.pathname === '/api/save') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200); return res.end('ok');
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`fixture server: http://localhost:${PORT} (${APP}-app.html)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
