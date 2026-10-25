#!/data/data/com.termux/files/usr/bin/bash
set -eu
umask 077
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$HOME/.pi/agent/bin:$HOME/.local/share/pi-node/current/bin:$PREFIX/bin"
export TERM=xterm-256color
if [ -f "$PREFIX/lib/libtermux-exec.so" ]; then
  export LD_PRELOAD="$PREFIX/lib/libtermux-exec.so${LD_PRELOAD:+:$LD_PRELOAD}"
fi
voice_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/voice"
mkdir -p "$voice_dir"
chmod 700 "$voice_dir"
# Nonblocking, success-on-contention: the independent host is already running or starting.
exec "$PREFIX/bin/flock" -n -E 0 "$voice_dir/app-launch.lock" "$PREFIX/bin/node" "$HOME/pi-voice/native/host.mjs"
