const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the sidebar receives extraction, transcription, and completion status', async () => {
  const messages = [];
  const sidebarHandlers = {};
  const eventHandlers = {};
  const actions = {};
  const loadedTracks = [];
  const overlayCalls = [];
  let runStatus = 0;
  const values = {
    ffmpegPath: '/opt/homebrew/bin/ffmpeg', whisperPath: '/opt/homebrew/bin/whisper-cli',
    modelPath: '/model.bin', maxLineLength: 42, customPrompt: '',
    saveNextToVideo: true, enableDtw: false,
  };
  const iina = {
    core: { osd() {}, subtitle: { loadTrack(file) { loadedTracks.push(file); } } },
    mpv: { getString() { return '/video.mp4'; } },
    utils: {
      resolvePath(value) { return value; }, fileInPath() { return true; },
      async exec(command, args, cwd, stdoutHook, stderrHook) {
        if (command === '/usr/bin/shasum') return { status: 0, stdout: '137c40403d78fd54d454da0f9bd998f78703390c  ' + args[2], stderr: '' };
        assert.equal(command, '/bin/bash');
        assert.match(args[1], /-sow -pp --prompt/);
        stdoutHook('AUTOSUB_STAGE:transcribe\n');
        stderrHook('whisper_print_progress_callback: progress =  2');
        stderrHook('5%\nwhisper_print_progress_callback: progress =  50%\n');
        return { status: runStatus, stdout: '', stderr: runStatus ? 'Whisper failed' : '' };
      },
    },
    menu: { item(title, action) { actions[title] = action; return {}; }, separator() { return {}; }, addItem() {} },
    file: { exists(file) { return !file.includes('autosub.cancel.'); } },
    preferences: { get(key) { return values[key]; } },
    console: { error() {} }, event: { on(name, callback) { eventHandlers[name] = callback; } },
    sidebar: {
      onMessage(name, callback) { sidebarHandlers[name] = callback; },
      loadFile(file) { assert.equal(file, 'status.html'); },
      postMessage(name, data) { messages.push({ name, data }); },
      show() {},
    },
    overlay: {
      simpleMode() { overlayCalls.push(['simpleMode']); },
      setStyle(style) { overlayCalls.push(['setStyle', style]); },
      setClickable(value) { overlayCalls.push(['setClickable', value]); },
      setContent(content) { overlayCalls.push(['setContent', content]); },
      show() { overlayCalls.push(['show']); },
      hide() { overlayCalls.push(['hide']); },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  vm.runInNewContext(source, { iina, setTimeout, clearTimeout });
  assert.equal(typeof eventHandlers['iina.window-loaded'], 'function');
  eventHandlers['iina.window-loaded']();
  assert.equal(typeof sidebarHandlers.ready, 'function');
  sidebarHandlers.ready();
  assert.equal(messages.at(-1).data.phase, 'idle');
  actions['Generate Subtitles (Standard)']();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(messages.filter(item => item.name === 'status').map(item => item.data.phase), ['idle', 'model', 'extract', 'transcribe', 'transcribe', 'transcribe', 'done']);
  assert.deepEqual(messages.filter(item => item.data.phase === 'transcribe').map(item => item.data.progress), [0, 25, 50]);
  assert.deepEqual(overlayCalls.filter(call => call[0] === 'setContent').map(call => call[1]), [
    '<span class="subtitle-progress">Subtitle is generating - 0%</span>',
    '<span class="subtitle-progress">Subtitle is generating - 0%</span>',
    '<span class="subtitle-progress">Subtitle is generating - 25%</span>',
    '<span class="subtitle-progress">Subtitle is generating - 50%</span>',
  ]);
  assert.equal(overlayCalls.filter(call => call[0] === 'show').length, 1);
  assert.equal(overlayCalls.at(-1)[0], 'hide');
  assert.deepEqual(loadedTracks, ['/video.srt']);
  sidebarHandlers.ready();
  assert.equal(messages.at(-1).data.phase, 'done');
  runStatus = 1;
  actions['Generate Subtitles (Standard)']();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.at(-1).data.phase, 'failed');
  assert.equal(overlayCalls.filter(call => call[0] === 'show').length, 2);
  assert.equal(overlayCalls.filter(call => call[0] === 'hide').length, 2);
  assert.deepEqual(loadedTracks, ['/video.srt']);
});

test('the sidebar page script parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'status.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
});

test('Plugin menu actions remain available when the sidebar fails to initialize', () => {
  const titles = [];
  const eventHandlers = {};
  const iina = {
    core: {}, mpv: {}, utils: {}, file: {}, preferences: {},
    console: { error() {}, warn() {} }, event: { on(name, callback) { eventHandlers[name] = callback; } },
    menu: {
      item(title) { titles.push(title); return {}; },
      separator() { return {}; }, addItem() {},
    },
    sidebar: {
      onMessage() {},
      loadFile() { throw new Error('webview unavailable'); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), { iina });
  eventHandlers['iina.window-loaded']();
  assert.ok(titles.includes('Generate Subtitles (Standard)'));
  assert.ok(titles.includes('Generate Subtitles (Short-Form, 15 chars)'));
  assert.ok(titles.includes('Cancel Subtitle Generation'));
  assert.ok(titles.includes('Download ggml-base.en.bin'));
  assert.ok(titles.indexOf('Download ggml-base.en.bin') < titles.indexOf('Show AutoSub Status'));
});
