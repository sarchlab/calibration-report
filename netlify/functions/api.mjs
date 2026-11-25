import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';
import {handleApi} from '../lib/api.js';

let database;

export default (request) => {
  if (!database) {
    database = getDatabase();
    // An idle client's disconnect is emitted on the pool (pg and Neon
    // pools alike); unhandled, it would end the process.
    database.pool.on('error', (error) =>
      console.error('Idle database client error:', error.message),
    );
  }
  return handleApi(request, {
    pool: database.pool,
    store: getStore({name: 'summaries', consistency: 'strong'}),
    env: process.env,
  });
};

export const config = {path: '/api/v1/*'};
