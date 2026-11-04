// Prepares a GitHub Codespace (or any computer) for trying Auto SMS for ERPNext:
// creates .env with a random dashboard password the first time, then prints how to log in.
import crypto from 'node:crypto';
import fs from 'node:fs';

const file = '.env';
if (!fs.existsSync(file)) {
  const password = crypto.randomBytes(12).toString('base64url');
  const env = fs
    .readFileSync('.env.example', 'utf8')
    .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${password}`)
    .replace(/^# PORT=3000.*$/m, 'PORT=3000')
    .replace(/^# TRUST_PROXY=true.*$/m, 'TRUST_PROXY=true');
  fs.writeFileSync(file, env, { mode: 0o600 });
}

const password = fs.readFileSync(file, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] ?? '(see .env)';
const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } = process.env;
const url =
  CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : 'http://localhost:3000';

const line = '='.repeat(64);
console.log(`\n${line}
  Auto SMS for ERPNext – test copy
  Dashboard: ${url}
  Password:  ${password}
  (also in the .env file; the "Ports" tab → port 3000 opens the dashboard too)
  Step-by-step test guide: TESTING.md
${line}\n`);
