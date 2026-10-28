import 'dotenv/config';
import { loadConfig } from './config.js';
import { startServer } from './server.js';

await startServer(loadConfig());
