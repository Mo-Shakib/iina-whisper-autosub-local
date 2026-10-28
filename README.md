# Whisper AutoSub (Local) for IINA

Generate English `.srt` subtitles for the local video playing in IINA with FFmpeg and whisper.cpp. The plugin loads the finished subtitles into the current player.

## Setup

1. Install the tools: `brew install ffmpeg whisper-cpp`.
2. In **IINA → Settings → Plugins**, choose **Install from GitHub** and enter `Mo-Shakib/iina-whisper-autosub-local`. You can also open the `.iinaplgz` file from the latest GitHub release in IINA.
3. Enable **Whisper AutoSub (Local)**. Edit the FFmpeg or Whisper executable path in Preferences if needed.
4. Open a local video and generate subtitles. AutoSub checks for an existing Base English model, verifies it, and offers a one-time download (about 142 MiB) if none is ready. You can still set a custom model path in Preferences.

For development from this source folder, run `./install-dev.sh` and restart IINA. Remove that development symlink before testing a GitHub installation of the same plugin.

With a local video open, press **Option+S** for the configured line length or **Option+Shift+S** for 15 characters. The same actions and **Cancel Subtitle Generation** are in IINA's Plugin menu.

While subtitles are being generated, a progress message appears near the bottom of the video where subtitles normally appear. It starts at 0% during audio extraction and follows Whisper's reported transcription percentage; the message disappears when generation finishes, fails, or is cancelled.

The **AutoSub** tab in IINA's sidebar shows the current stage, transcription progress, elapsed time, the video name, and the subtitle location or error. It opens automatically when a run starts. You can also open it with **Plugin → Show AutoSub Status**, and start or cancel a run from the tab. IINA needs a restart after plugin source changes to load the updated tab.

The completed `.srt` is saved beside the video by default. If that setting is off, it is saved in the plugin's persistent data folder. Each run uses a private temporary folder for audio and Whisper output; it is removed on success, error, or cancellation. The runner also stops when its IINA parent process exits. A forcibly killed runner cannot execute its cleanup trap; leftover temporary files from that rare case can be removed from the plugin's `@tmp` folder.

The model download uses the network once. AutoSub verifies the model against the checksum published by whisper.cpp before using it. Subtitle generation itself runs locally.

## Release

Run `node --test tests/*.test.js`, then `node scripts/package-release.js`. Attach the resulting `Whisper-AutoSub-Local.iinaplgz` to a GitHub release tagged with the version from `Info.json`. Increase `ghVersion` for each later public release.
