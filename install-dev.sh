#!/usr/bin/env bash
set -euo pipefail

plugin_dir="$HOME/Library/Application Support/com.colliderli.iina/plugins"
link="$plugin_dir/io.bento.iina-whisper-autosub.iinaplugin-dev"
source_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$plugin_dir"
if [[ -e "$link" && ! -L "$link" ]]; then
  echo "Refusing to replace an existing non-symlink: $link" >&2
  exit 1
fi
ln -sfn "$source_dir" "$link"
echo "Linked $source_dir to $link"
echo "Restart IINA, enable Whisper AutoSub (Local) in Settings > Plugins, then open a local video and press Option+S."
