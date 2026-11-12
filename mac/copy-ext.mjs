// Copies the extension's pages and logic into ext/, which the app loads. The
// extension stays the one source; this folder only adds the desktop shell.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = ['manifest.json', 'shared.js', 'background.js', 'lib.js', 'github.js', 'dom.js', 'builder.js', 'theme.css', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'options.html', 'options.css', 'options.js', 'icon.png'];
rmSync('ext', { recursive: true, force: true });
mkdirSync('ext');
for (const f of FILES) cpSync(`../extension/${f}`, `ext/${f}`);
console.log(`copied ${FILES.length} files from ../extension`);
