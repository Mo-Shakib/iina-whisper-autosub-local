// IINA's main entry runs in JavaScriptCore, not Node.js.
const { core, mpv, utils, menu, file, preferences, console: logger, event, sidebar, overlay } = iina;

let activeRun = null;
let downloadingModel = false;
let preparingModel = false;
let progressOverlayReady = false;
let progressOverlayVisible = false;
const MODEL_SHA1 = "137c40403d78fd54d454da0f9bd998f78703390c";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
let currentStatus = {
  phase: "idle",
  message: "Ready to generate subtitles",
  detail: "Open a local video, then start a run.",
  video: "",
  output: "",
  startedAt: null,
  endedAt: null,
  busy: false,
  progress: null,
};

function syncProgressOverlay() {
  if (!overlay) return;
  const visible = currentStatus.busy && ['extract', 'transcribe'].includes(currentStatus.phase);
  try {
    if (!visible) {
      if (progressOverlayVisible) overlay.hide();
      progressOverlayVisible = false;
      return;
    }
    if (!progressOverlayReady) {
      overlay.simpleMode();
      overlay.setStyle('html, body, .content { width: 100%; height: 100%; margin: 0; background: transparent; } .content { box-sizing: border-box; display: flex; align-items: flex-end; justify-content: center; padding: 0 20px 7%; } .subtitle-progress { color: white; font: 600 clamp(18px, 2.5vw, 30px)/1.25 -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; text-shadow: 0 2px 4px black, 0 0 8px black; }');
      overlay.setClickable(false);
      progressOverlayReady = true;
    }
    overlay.setContent('<span class="subtitle-progress">Subtitle is generating - ' + currentStatus.progress + '%</span>');
    if (!progressOverlayVisible) overlay.show();
    progressOverlayVisible = true;
  } catch (error) {
    logger.warn('AutoSub progress overlay update failed: ' + error);
  }
}

function updateStatus(changes) {
  currentStatus = Object.assign({}, currentStatus, changes);
  syncProgressOverlay();
  try { sidebar.postMessage("status", currentStatus); }
  catch (error) { logger.warn("AutoSub status panel update failed: " + error); }
}

function showStatusPanel() {
  try { sidebar.show(); }
  catch (error) { logger.warn("AutoSub status panel could not open: " + error); }
}

// Each invocation owns a private directory. The shell trap removes it on exit,
// including a failed command or a TERM/INT signal. The cancel marker lets IINA
// stop a running child without needing a process handle from utils.exec().
const RUNNER = `#!/bin/bash
set -u
ffmpeg=$1
whisper=$2
model=$3
video=$4
output=$5
max_len=$6
prompt=$7
dtw=$8
tmp_root=$9
token=\${10}
parent_pid=$PPID
cancel="$tmp_root/autosub.cancel.$token"
work=""
child=""
stage_copy="$output.part.$token"

cleanup() {
  if [[ -n "$child" ]]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  [[ -z "$work" ]] || rm -rf -- "$work"
  rm -f -- "$stage_copy" "$cancel"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

check_cancel() {
  if [[ -e "$cancel" ]] || ! kill -0 "$parent_pid" 2>/dev/null; then
    echo 'Subtitle generation cancelled.' >&2
    exit 130
  fi
}

run_step() {
  check_cancel
  "$@" &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    if [[ -e "$cancel" ]] || ! kill -0 "$parent_pid" 2>/dev/null; then
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      child=""
      check_cancel
    fi
    sleep 0.2
  done
  wait "$child"
  result=$?
  child=""
  check_cancel
  return "$result"
}

mkdir -p -- "$tmp_root" || exit 1
work=$(mktemp -d "$tmp_root/autosub.$token.XXXXXXXX") || exit 1
check_cancel
echo 'AUTOSUB_STAGE:extract'
if ! run_step "$ffmpeg" -nostdin -y -loglevel error -i "$video" -ar 16000 -ac 1 -c:a pcm_s16le "$work/audio.wav"; then
  echo 'FFmpeg could not extract audio.' >&2
  exit 1
fi
check_cancel
echo 'AUTOSUB_STAGE:transcribe'
args=(-m "$model" -f "$work/audio.wav" -osrt -of "$work/caption" -ml "$max_len" -sow -pp --prompt "$prompt")
if [[ "$dtw" == true ]]; then
  if ! run_step "$whisper" "\${args[@]}" -dtw base.en; then
    check_cancel
    rm -f -- "$work/caption.srt"
    echo 'DTW failed; retrying without word alignment.' >&2
    if ! run_step "$whisper" "\${args[@]}"; then
      echo 'Whisper transcription failed.' >&2
      exit 1
    fi
  fi
elif ! run_step "$whisper" "\${args[@]}"; then
  echo 'Whisper transcription failed.' >&2
  exit 1
fi
check_cancel
if [[ ! -s "$work/caption.srt" ]]; then
  echo 'Whisper did not produce a nonempty SRT file.' >&2
  exit 1
fi
mkdir -p -- "$(dirname "$output")" || exit 1
cp -- "$work/caption.srt" "$stage_copy" || exit 1
check_cancel
mv -f -- "$stage_copy" "$output" || exit 1
echo 'AUTOSUB_STAGE:done'
`;

function resolveUserPath(value) {
  return utils.resolvePath(String(value || "").trim());
}

function binaryFor(key, name) {
  const configured = String(preferences.get(key) || "").trim();
  const resolved = resolveUserPath(configured);
  if (resolved && utils.fileInPath(resolved)) return resolved;
  // macOS GUI apps often lack Homebrew directories in PATH.
  const standardDefault = "/opt/homebrew/bin/" + name;
  if (configured === standardDefault) {
    const intelPath = "/usr/local/bin/" + name;
    if (utils.fileInPath(intelPath)) return intelPath;
  }
  throw new Error(name + " was not found at " + configured + ". Install with brew install ffmpeg whisper-cpp, then update the plugin preferences.");
}

function videoPath() {
  let path = mpv.getString("path") || "";
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(path.slice(7)); } catch (_) { return ""; }
  }
  return path.startsWith("/") && file.exists(path) ? path : "";
}

function subtitleDestination(video, token) {
  const slash = video.lastIndexOf("/");
  const dot = video.lastIndexOf(".");
  const stem = dot > slash ? video.slice(0, dot) : video;
  if (preferences.get("saveNextToVideo") !== false) return stem + ".srt";
  const name = stem.slice(slash + 1).replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolveUserPath("@data/subtitles/") + "/" + name + "-" + token + ".srt";
}

function maxLength(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    throw new Error("Standard line length must be an integer from 1 to 200.");
  }
  return String(number);
}

async function isValidModel(path) {
  if (!path || !file.exists(path)) return false;
  try {
    const result = await utils.exec("/usr/bin/shasum", ["-a", "1", path]);
    const match = result.stdout && result.stdout.match(/^([0-9a-f]{40})\s/);
    return result.status === 0 && !!match && match[1] === MODEL_SHA1;
  } catch (error) {
    logger.warn("Could not check Whisper model: " + error);
    return false;
  }
}

async function findExistingModel() {
  const candidates = [
    preferences.get("modelPath"),
    "@data/ggml-base.en.bin",
    "~/subtitle-cli/ggml-base.en.bin",
    "~/whisper.cpp/models/ggml-base.en.bin",
    "~/Downloads/ggml-base.en.bin",
  ];
  const checked = {};
  for (const candidate of candidates) {
    const path = resolveUserPath(candidate);
    if (!path || checked[path]) continue;
    checked[path] = true;
    if (await isValidModel(path)) {
      if (preferences.get("modelPath") !== path) {
        preferences.set("modelPath", path);
        preferences.sync();
      }
      return path;
    }
  }
  return null;
}

async function downloadModelFile() {
  const target = resolveUserPath("@data/ggml-base.en.bin");
  const partial = target + ".part." + Date.now() + "-" + Math.random().toString(36).slice(2);
  let lastPercent = -1;
  const onProgress = chunk => {
    const percentages = String(chunk).match(/\d+(?:\.\d+)?%/g);
    if (!percentages) return;
    const percent = Math.floor(Number(percentages[percentages.length - 1].slice(0, -1)));
    if (percent >= lastPercent + 5 || percent === 100) {
      lastPercent = percent;
      updateStatus({ phase: "download", message: "Downloading Whisper model", detail: "Whisper Base English (142 MiB): " + percent + "%" });
    }
  };
  try {
    updateStatus({ phase: "download", message: "Downloading Whisper model", detail: "Whisper Base English (142 MiB)." });
    core.osd("Downloading Whisper Base English model…");
    const result = await utils.exec("/usr/bin/curl", ["--fail", "--location", "--retry", "2", "--progress-bar", "--output", partial, MODEL_URL], undefined, undefined, onProgress);
    if (result.status !== 0 || !file.exists(partial)) throw new Error("Model download failed. Check your connection and try again.");
    updateStatus({ phase: "download", message: "Verifying Whisper model", detail: "Checking the downloaded file before use." });
    if (!(await isValidModel(partial))) throw new Error("Downloaded model failed verification. Please try again.");
    const moved = await utils.exec("/bin/mv", ["-f", partial, target]);
    if (moved.status !== 0) throw new Error("Could not save the downloaded model.");
    preferences.set("modelPath", target);
    preferences.sync();
    return target;
  } finally {
    if (file.exists(partial)) file.delete(partial);
  }
}

function reportError(error, label) {
  const message = error && error.message ? error.message : String(error);
  logger.error(message);
  core.osd("Whisper AutoSub: " + message);
  updateStatus({ phase: "failed", message: label || "Subtitle generation failed", detail: message, video: currentStatus.busy ? currentStatus.video : "", output: "", startedAt: currentStatus.busy ? currentStatus.startedAt : null, busy: false, endedAt: Date.now() });
}

async function generate(shortForm) {
  if (activeRun || downloadingModel || preparingModel) {
    showStatusPanel();
    core.osd("Whisper AutoSub is already busy.");
    return;
  }
  const video = videoPath();
  if (!video) {
    showStatusPanel();
    core.osd("Open a local video file first.");
    updateStatus({ phase: "idle", message: "Open a local video file first", detail: "Then choose Standard or Short-form.", video: "", output: "", startedAt: null, endedAt: null, busy: false });
    return;
  }

  preparingModel = true;
  try {
    const ffmpeg = binaryFor("ffmpegPath", "ffmpeg");
    const whisper = binaryFor("whisperPath", "whisper-cli");
    showStatusPanel();
    updateStatus({ phase: "model", message: "Checking Whisper model", detail: "Looking for a verified Base English model.", video, output: "", startedAt: Date.now(), endedAt: null, busy: true });
    let model = await findExistingModel();
    if (!model) {
      const accepted = utils.ask("Whisper Base English (142 MiB) was not found or could not be verified. Download it to the plugin data folder now?");
      if (!accepted) {
        updateStatus({ phase: "idle", message: "Whisper model needed", detail: "Set a valid model path in Preferences or use the Plugin menu to download it.", busy: false, endedAt: Date.now() });
        return;
      }
      model = await downloadModelFile();
    }
    const length = shortForm ? "15" : maxLength(preferences.get("maxLineLength") || "42");
    const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    const tmpRoot = resolveUserPath("@tmp/");
    const cancel = tmpRoot + "/autosub.cancel." + token;
    const output = subtitleDestination(video, token);
    const run = { cancel, cancelled: false, video };
    activeRun = run;
    preparingModel = false;
    showStatusPanel();
    updateStatus({ phase: "extract", message: "Extracting audio", detail: "Converting the video's audio to 16 kHz mono.", video, output: "", startedAt: Date.now(), endedAt: null, busy: true, progress: 0 });
    core.osd("[1/2] Extracting 16 kHz audio…");
    let stageBuffer = "";
    const onOutput = chunk => {
      stageBuffer += chunk;
      if (stageBuffer.indexOf("AUTOSUB_STAGE:transcribe") !== -1) {
        core.osd("[2/2] Transcribing with Whisper…");
        updateStatus({ phase: "transcribe", message: "Transcribing with Whisper", detail: "Whisper transcription: 0% complete.", progress: 0 });
        stageBuffer = "";
      } else if (stageBuffer.length > 100) {
        stageBuffer = stageBuffer.slice(-40);
      }
    };
    let errorBuffer = "";
    const onErrorOutput = chunk => {
      errorBuffer += String(chunk);
      let newline;
      while ((newline = errorBuffer.indexOf("\n")) !== -1) {
        const line = errorBuffer.slice(0, newline).trim();
        errorBuffer = errorBuffer.slice(newline + 1);
        if (line.includes("DTW failed; retrying without word alignment.")) {
          updateStatus({ phase: "transcribe", message: "Retrying transcription", detail: "Word alignment failed; continuing without it.", progress: 0 });
          continue;
        }
        const match = line.match(/whisper_print_progress_callback:\s*progress\s*=\s*(\d{1,3})%/);
        if (match && currentStatus.phase === "transcribe") {
          const progress = Math.min(100, Number(match[1]));
          if (progress > currentStatus.progress) {
            updateStatus({ progress, detail: "Whisper transcription: " + progress + "% complete." });
          }
        }
      }
      if (errorBuffer.length > 512) errorBuffer = errorBuffer.slice(-256);
    };
    try {
      const result = await utils.exec("/bin/bash", ["-c", RUNNER, "autosub", ffmpeg, whisper, model, video, output, length, String(preferences.get("customPrompt") || ""), preferences.get("enableDtw") === false ? "false" : "true", tmpRoot, token], undefined, onOutput, onErrorOutput);
      if (run.cancelled || result.status === 130) {
        core.osd("Subtitle generation cancelled.");
        updateStatus({ phase: "cancelled", message: "Generation cancelled", detail: "Temporary files were removed.", busy: false, endedAt: Date.now() });
      } else if (result.status !== 0) {
        throw new Error((result.stderr || "Subtitle generation failed.").trim().split("\n").slice(-2).join(" "));
      } else if (!file.exists(output)) {
        throw new Error("Whisper finished but the subtitle file is missing.");
      } else {
        if (videoPath() === video) {
          core.subtitle.loadTrack(output);
          core.osd("Subtitles generated and loaded.");
          updateStatus({ phase: "done", message: "Subtitles ready", detail: "The subtitle track was loaded into IINA.", output, busy: false, endedAt: Date.now() });
        } else {
          core.osd("Subtitles saved; the original video is no longer open.");
          updateStatus({ phase: "done", message: "Subtitles saved", detail: "The original video is no longer open.", output, busy: false, endedAt: Date.now() });
        }
      }
    } finally {
      // Also cover failures to launch bash, before its EXIT trap can run.
      if (file.exists(cancel)) file.delete(cancel);
      activeRun = null;
    }
  } catch (error) {
    reportError(error);
  } finally {
    preparingModel = false;
  }
}

function cancelGeneration() {
  if (!activeRun) {
    core.osd("No subtitle generation is running.");
    return;
  }
  try {
    file.write(activeRun.cancel, "cancel");
    activeRun.cancelled = true;
    core.osd("Cancelling subtitle generation…");
    updateStatus({ phase: "cancelling", message: "Cancelling…", detail: "Stopping the current command and cleaning temporary files." });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logger.error(message);
    core.osd("Whisper AutoSub: " + message);
    updateStatus({ message: "Cancellation could not be requested", detail: message });
  }
}

async function downloadModel() {
  if (activeRun || downloadingModel || preparingModel) {
    core.osd("Whisper AutoSub is already busy.");
    return;
  }
  downloadingModel = true;
  try {
    showStatusPanel();
    updateStatus({ phase: "model", message: "Checking Whisper model", detail: "Looking for a verified Base English model.", video: "", output: "", startedAt: Date.now(), endedAt: null, busy: true });
    const existing = await findExistingModel();
    if (existing) {
      core.osd("Whisper model is ready.");
      updateStatus({ phase: "done", message: "Model ready", detail: "Using " + existing, busy: false, endedAt: Date.now() });
    } else {
      await downloadModelFile();
      core.osd("Whisper model downloaded.");
      updateStatus({ phase: "done", message: "Model downloaded", detail: "You can now generate subtitles.", busy: false, endedAt: Date.now() });
    }
  } catch (error) {
    reportError(error, "Model download failed");
  } finally {
    downloadingModel = false;
  }
}

menu.addItem(menu.item("Generate Subtitles (Standard)", () => { generate(false); }, { keyBinding: "Alt+s" }));
menu.addItem(menu.item("Generate Subtitles (Short-Form, 15 chars)", () => { generate(true); }, { keyBinding: "Alt+Shift+s" }));
menu.addItem(menu.item("Cancel Subtitle Generation", cancelGeneration));
menu.addItem(menu.item("Download ggml-base.en.bin", () => { downloadModel(); }));
menu.addItem(menu.item("Show AutoSub Status", () => { showStatusPanel(); updateStatus({}); }));

// IINA creates the sidebar webview after the player window loads.
event.on("iina.window-loaded", () => {
  try {
    sidebar.onMessage("ready", () => updateStatus({}));
    sidebar.onMessage("generate-standard", () => { generate(false); });
    sidebar.onMessage("generate-short", () => { generate(true); });
    sidebar.onMessage("cancel", () => { cancelGeneration(); });
    sidebar.loadFile("status.html");
  } catch (error) {
    logger.error("AutoSub status panel could not initialize: " + error);
  }
});

function cancelIfVideoChanged() {
  if (activeRun && videoPath() !== activeRun.video) cancelGeneration();
}
event.on("iina.file-loaded", cancelIfVideoChanged);
event.on("mpv.end-file", cancelIfVideoChanged);
