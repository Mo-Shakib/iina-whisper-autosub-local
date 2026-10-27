const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const context = {
  iina: {
    core: {}, mpv: {}, utils: {}, file: {}, preferences: {}, console: {}, event: { on() {} },
    sidebar: { onMessage() {}, loadFile() {}, postMessage() {} },
    menu: { item() {}, separator() {}, addItem() {} },
  },
};
vm.runInNewContext(source + '\nglobalThis.runnerForTest = RUNNER;', context);
const runner = context.runnerForTest;

function script(file, content) {
  fs.writeFileSync(file, '#!/bin/bash\n' + content, { mode: 0o755 });
}

async function runCase(mode, cancelDuringWhisper = false, dtw = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iina-autosub-test-'));
  const temp = path.join(root, 'temp');
  const video = path.join(root, 'video with spaces.mp4');
  const output = path.join(root, 'video with spaces.srt');
  const ffmpeg = path.join(root, 'ffmpeg');
  const whisper = path.join(root, 'whisper');
  const token = 'case-token';
  fs.mkdirSync(temp);
  fs.writeFileSync(video, 'fake video');
  fs.writeFileSync(path.join(root, 'model.bin'), 'fake model');
  script(ffmpeg, 'if [[ "$MODE" == extract-fail ]]; then exit 2; fi\nprintf audio > "${@: -1}"\n');
  script(whisper, 'if [[ "$MODE" == transcribe-fail ]]; then exit 3; fi\nif [[ "$MODE" == slow ]]; then touch "$STARTED"; exec sleep 5; fi\nfor ((i=1;i<=$#;i++)); do if [[ "${!i}" == -of ]]; then j=$((i+1)); prefix="${!j}"; fi; if [[ "${!i}" == -dtw && "$MODE" == dtw-fail ]]; then exit 4; fi; done\nprintf "1\\n00:00:00,000 --> 00:00:01,000\\nHello\\n" > "$prefix.srt"\nprintf "extra" > "$prefix.json"\n');
  let status;
  let stdout = '';
  try {
    status = await new Promise((resolve, reject) => {
      const started = path.join(root, 'started');
      const child = spawn('/bin/bash', ['-c', runner, 'autosub', ffmpeg, whisper, path.join(root, 'model.bin'), video, output, '42', 'Prompt', String(dtw), temp, token], { env: { ...process.env, MODE: mode, STARTED: started } });
      const cancelTimer = cancelDuringWhisper ? setInterval(() => {
        if (fs.existsSync(started)) {
          fs.writeFileSync(path.join(temp, 'autosub.cancel.' + token), 'cancel');
          clearInterval(cancelTimer);
        }
      }, 10) : null;
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', code => {
        if (cancelTimer) clearInterval(cancelTimer);
        resolve(code);
      });
    });
    assert.deepEqual(fs.readdirSync(temp), [], 'all run files and cancel markers should be removed');
    assert.equal(fs.existsSync(output), mode === 'success' || mode === 'dtw-fail');
    return status;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('success keeps only the SRT', async () => assert.equal(await runCase('success'), 0));
test('FFmpeg failure removes temporary files', async () => assert.notEqual(await runCase('extract-fail'), 0));
test('Whisper failure removes temporary files', async () => assert.notEqual(await runCase('transcribe-fail'), 0));
test('cancel stops transcription and removes temporary files', async () => assert.equal(await runCase('slow', true), 130));
test('DTW failure retries and removes temporary files', async () => assert.equal(await runCase('dtw-fail', false, true), 0));
