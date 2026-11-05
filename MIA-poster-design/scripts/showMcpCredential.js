import dotenv from 'dotenv';
import { mcpSecret } from '../src/canvaBridge.js';

dotenv.config({ override: true, quiet: true });

const apiKey = process.env.MEETSTREAM_API_KEY?.trim();
if (!apiKey || /^your_.+_here$/i.test(apiKey)) {
  throw new Error('Fill in MEETSTREAM_API_KEY in .env first.');
}

console.log(`Bearer ${mcpSecret(apiKey)}`);
