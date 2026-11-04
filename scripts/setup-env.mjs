// First run on a new computer (your PC, a Mac, or a GitHub Codespace):
// creates .env with a random dashboard password, then prints how to log in.
import crypto from 'node:crypto';
import fs from 'node:fs';

const file = '.env';
if (!fs.existsSync(file)) {
  const password = crypto.randomBytes(12).toString('base64url');
  const env = fs
    .readFileSync('.env.example', 'utf8')
    .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${password}`)
    .replace(/^# PORT=3000.*$/m, 'PORT=3000')
    .replace(/^# TRUST_PROXY=true.*$/m, process.env.CODESPACE_NAME ? 'TRUST_PROXY=true' : '# TRUST_PROXY=true');
  fs.writeFileSync(file, env, { mode: 0o600 });
}

const text = fs.readFileSync(file, 'utf8');
const password = text.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] ?? '(see .env)';
const port = text.match(/^PORT=(\d+)/m)?.[1] ?? '3000';
const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } = process.env;
const inCodespace = Boolean(CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN);
const url = inCodespace ? `https://${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}` : `http://localhost:${port}`;
const hint = inCodespace
  ? 'The "Ports" tab → port 3000 opens the dashboard too.'
  : 'Your browser opens it in a moment. Keep this window open while you test.';

const line = '='.repeat(64);
console.log(`\n${line}
  Auto SMS for ERPNext
  Dashboard: ${url}
  Password:  ${password}
  ${hint}
  The password is also in the .env file. Test guide: TESTING.md
${line}\n`);
