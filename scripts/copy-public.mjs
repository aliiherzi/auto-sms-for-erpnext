// Copies the dashboard's static files next to the compiled server code.
import { cpSync } from 'node:fs';
cpSync('src/web/public', 'dist/web/public', { recursive: true });
