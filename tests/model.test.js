const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const goodHash = '137c40403d78fd54d454da0f9bd998f78703390c';

function setup({ existing = [], valid = [], accept = false, downloadValid = true, downloadFails = false } = {}) {
  const files = new Set(['/video.mp4', ...existing]);
  const validPaths = new Set(valid);
  const calls = [];
  const messages = [];
  const settings = {
    ffmpegPath: '/opt/homebrew/bin/ffmpeg', whisperPath: '/opt/homebrew/bin/whisper-cli',
    modelPath: '/missing-model.bin', maxLineLength: 42, customPrompt: '',
    saveNextToVideo: true, enableDtw: false,
  };
  let asked = 0;
  const iina = {
    core: { osd() {}, subtitle: { loadTrack() {} } },
    mpv: { getString() { return '/video.mp4'; } },
    utils: {
      resolvePath(value) { return value; }, fileInPath() { return true; },
      ask() { asked++; return accept; },
      async exec(command, args, cwd, stdoutHook) {
        calls.push({ command, args });
        if (command === '/usr/bin/shasum') {
          const candidate = args[2];
          const hash = validPaths.has(candidate) || (downloadValid && candidate.includes('.part.')) ? goodHash : '0'.repeat(40);
          return { status: 0, stdout: hash + '  ' + candidate, stderr: '' };
        }
        if (command === '/usr/bin/curl') {
          files.add(args[args.indexOf('--output') + 1]);
          return { status: downloadFails ? 22 : 0, stdout: '', stderr: '' };
        }
        if (command === '/bin/mv') {
          files.delete(args[1]); files.add(args[2]);
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command === '/bin/bash') {
          files.add(args[7]);
          stdoutHook('AUTOSUB_STAGE:transcribe\n');
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error('unexpected command ' + command);
      },
    },
    file: { exists(file) { return files.has(file); }, delete(file) { files.delete(file); } },
    preferences: { get(key) { return settings[key]; }, set(key, value) { settings[key] = value; }, sync() {} },
    console: { error() {}, warn() {} }, event: { on() {} },
    menu: { item() { return {}; }, separator() { return {}; }, addItem() {} },
    sidebar: { onMessage() {}, loadFile() {}, postMessage(name, data) { messages.push({ name, data }); }, show() {} },
  };
  const context = vm.createContext({ iina });
  vm.runInContext(source, context);
  return { context, files, settings, calls, messages, asked: () => asked };
}

test('finds and remembers an existing verified legacy model', async () => {
  const fixture = setup({ existing: ['~/subtitle-cli/ggml-base.en.bin'], valid: ['~/subtitle-cli/ggml-base.en.bin'] });
  await fixture.context.generate(false);
  assert.equal(fixture.settings.modelPath, '~/subtitle-cli/ggml-base.en.bin');
  assert.equal(fixture.asked(), 0);
  assert.equal(fixture.calls.some(call => call.command === '/usr/bin/curl'), false);
  assert.equal(fixture.calls.some(call => call.command === '/bin/bash'), true);
});

test('offers a download when no verified model exists and can be declined', async () => {
  const fixture = setup({ accept: false });
  await fixture.context.generate(false);
  assert.equal(fixture.asked(), 1);
  assert.equal(fixture.calls.some(call => call.command === '/usr/bin/curl'), false);
  assert.equal(fixture.calls.some(call => call.command === '/bin/bash'), false);
});

test('downloads, verifies, and uses a model on the first run', async () => {
  const fixture = setup({ accept: true });
  await fixture.context.generate(false);
  assert.equal(fixture.asked(), 1);
  assert.equal(fixture.settings.modelPath, '@data/ggml-base.en.bin');
  assert.equal(fixture.files.has('@data/ggml-base.en.bin'), true);
  assert.equal(fixture.calls.some(call => call.command === '/bin/bash'), true);
  assert.equal([...fixture.files].some(file => file.includes('.part.')), false);
});

test('rejects a corrupt download and removes the partial file', async () => {
  const fixture = setup({ accept: true, downloadValid: false });
  await fixture.context.generate(false);
  assert.equal(fixture.files.has('@data/ggml-base.en.bin'), false);
  assert.equal(fixture.calls.some(call => call.command === '/bin/bash'), false);
  assert.equal([...fixture.files].some(file => file.includes('.part.')), false);
  assert.equal(fixture.messages.at(-1).data.phase, 'failed');
});

test('cleans up a partial model when the download fails', async () => {
  const fixture = setup({ accept: true, downloadFails: true });
  await fixture.context.generate(false);
  assert.equal(fixture.files.has('@data/ggml-base.en.bin'), false);
  assert.equal([...fixture.files].some(file => file.includes('.part.')), false);
  assert.equal(fixture.calls.some(call => call.command === '/bin/bash'), false);
  assert.equal(fixture.messages.at(-1).data.phase, 'failed');
});
