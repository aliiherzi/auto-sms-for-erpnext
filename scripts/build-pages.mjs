// Builds the app for GitHub Pages into pages-dist/:
// the same dashboard, which connects to your Auto SMS server or shows a demo with sample data.
import fs from 'node:fs';

const out = 'pages-dist';
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync('src/web/public', out, { recursive: true });
fs.cpSync('demo', `${out}/demo`, { recursive: true });
fs.writeFileSync(`${out}/config.js`, '// The app on GitHub Pages: connect to your server, or try the demo.\nwindow.AUTO_SMS_STATIC = true;\n');
fs.writeFileSync(`${out}/.nojekyll`, '');
console.log(`Built ${out}/ (${fs.readdirSync(out).length} entries)`);
