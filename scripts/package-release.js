const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'iina-autosub-package-'));
const cli = process.env.IINA_PLUGIN_CLI || '/Applications/IINA.app/Contents/MacOS/iina-plugin';
const output = path.join(root, 'Whisper-AutoSub-Local.iinaplgz');

try {
  for (const name of ['Info.json', 'main.js', 'pref.html', 'status.html']) {
    fs.copyFileSync(path.join(root, name), path.join(staging, name));
  }
  const result = spawnSync(cli, ['pack', '.'], { cwd: staging, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'IINA packaging failed').trim());
  const archive = fs.readdirSync(staging).find(name => name.endsWith('.iinaplgz'));
  if (!archive) throw new Error('IINA did not create an archive');
  fs.copyFileSync(path.join(staging, archive), output);
  process.stdout.write(`Created ${output}\n`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
