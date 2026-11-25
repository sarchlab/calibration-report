import {getStore} from '@netlify/blobs';
import {getDatabase} from '@netlify/database';
import {handleApi} from '../lib/api.js';

let database;

export default (request) => {
  database ??= getDatabase();
  return handleApi(request, {
    pool: database.pool,
    store: getStore({name: 'summaries', consistency: 'strong'}),
    env: process.env,
  });
};

export const config = {path: '/api/v1/*'};
