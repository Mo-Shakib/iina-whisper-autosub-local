# Whisper AutoSub (Local) for IINA

Generate English `.srt` subtitles for the local video playing in IINA with FFmpeg and whisper.cpp. The plugin loads the finished subtitles into the current player.

## Setup

1. Install the tools: `brew install ffmpeg whisper-cpp`.
2. Put `ggml-base.en.bin` at `~/subtitle-cli/ggml-base.en.bin`, or use the plugin menu's **Download ggml-base.en.bin** action after installation.
3. In **IINA → Settings → Plugins**, choose **Install from GitHub** and enter `Mo-Shakib/iina-whisper-autosub-local`. You can also open the `.iinaplgz` file from the latest GitHub release in IINA.
4. Enable **Whisper AutoSub (Local)**. Edit the executable and model paths in its Preferences if needed.

For development from this source folder, run `./install-dev.sh` and restart IINA. Remove that development symlink before testing a GitHub installation of the same plugin.

With a local video open, press **Option+S** for the configured line length or **Option+Shift+S** for 15 characters. The same actions and **Cancel Subtitle Generation** are in IINA's Plugin menu.

The **AutoSub** tab in IINA's sidebar shows the current stage, elapsed time, the video name, and the subtitle location or error. It opens automatically when a run starts. You can also open it with **Plugin → Show AutoSub Status**, and start or cancel a run from the tab. IINA needs a restart after plugin source changes to load the updated tab.

The completed `.srt` is saved beside the video by default. If that setting is off, it is saved in the plugin's persistent data folder. Each run uses a private temporary folder for audio and Whisper output; it is removed on success, error, or cancellation. The runner also stops when its IINA parent process exits. A forcibly killed runner cannot execute its cleanup trap; leftover temporary files from that rare case can be removed from the plugin's `@tmp` folder.

The model download uses the network once. Subtitle generation itself runs locally.

## Release

Run `node --test tests/*.test.js`, then `node scripts/package-release.js`. Attach the resulting `Whisper-AutoSub-Local.iinaplgz` to a GitHub release tagged with the version from `Info.json`. Increase `ghVersion` for each later public release.
