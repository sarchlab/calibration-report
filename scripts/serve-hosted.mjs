// Local preview of the hosted site without Netlify: serves dist/ and the
// /api/v1 handler against any Postgres with the migration applied. Summaries
// are cached in memory.
//   VITE_HOSTED=1 npm run build
//   NETLIFY_DB_URL=postgresql://... node scripts/serve-hosted.mjs [port]
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize} from 'node:path';
import pg from 'pg';
import {handleApi} from '../netlify/lib/api.js';

const root = new URL('../dist/', import.meta.url).pathname;
const port = Number(process.argv[2] ?? 8888);
const pool = new pg.Pool({connectionString: process.env.NETLIFY_DB_URL});
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const blobs = new Map();
let version = 0;
const store = {
  async getWithMetadata(key) {
    return blobs.has(key) ? structuredClone(blobs.get(key)) : null;
  },
  async setJSON(key, data, {metadata, onlyIfMatch, onlyIfNew} = {}) {
    const current = blobs.get(key);
    if ((onlyIfNew && current) || (onlyIfMatch && current?.etag !== onlyIfMatch))
      return {modified: false};
    blobs.set(key, {data, metadata, etag: String(++version)});
    return {modified: true};
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const response = await handleApi(new Request(url, {method: req.method}), {
      pool,
      store,
      env: process.env,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
    return;
  }
  const path = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  try {
    if (!path.startsWith(root)) throw new Error('outside');
    const body = await readFile(path);
    res.writeHead(200, {'content-type': types[extname(path)] ?? 'application/octet-stream'});
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
