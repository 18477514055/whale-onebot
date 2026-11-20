#!/bin/sh
set -eu
umask 077
root=/mnt/d/qq-onebot
case "${2:-}" in ''|--read-only) ;; *) exit 2 ;; esac
test "$#" -le 2
snapshot=$(realpath -- "$1")
case "$snapshot" in "$HOME"/qq-onebot-lab/phone-agent-*) ;; *) exit 2 ;; esac
test -f "$snapshot/snapshot-manifest.json"
test -f "$snapshot/portable-dependencies/ws/package.json"
work=$(mktemp -d "$HOME/qq-onebot-lab/offline-agent-XXXXXXXX")
trap 'if test -d "$work"; then rm -rf -- "$work"; fi' EXIT
cp -a --reflink=auto -- "$snapshot/data" "$work/data"
mkdir -- "$work/home"
mkdir -- "$work/app"
cp -a --reflink=auto -- "$snapshot/app/." "$work/app/"
mkdir -- "$work/app/node_modules"
node="$root/.tools/node-v24.20.0-linux-x64/bin/node"
bwrap="$root/.tools/bubblewrap/extracted/usr/bin/bwrap"
timeout -k 5 75 "$bwrap" --unshare-all --unshare-user --disable-userns \
  --assert-userns-disabled --new-session --die-with-parent --cap-drop ALL --clearenv \
  --ro-bind /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu \
  --symlink /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 \
  --ro-bind "$node" /bin/node --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind "$work/app" /app --ro-bind "$snapshot/portable-dependencies" /app/node_modules \
  --ro-bind "$root/src" /project/src --ro-bind "$root/node_modules" /project/node_modules \
  --ro-bind "$root/experiments/agent-plus-full-linux.mjs" /project/experiments/agent-plus-full-linux.mjs \
  --bind "$work/data" /working --bind "$work/home" /lab-home \
  --setenv HOME /lab-home --setenv TMPDIR /tmp --setenv QQ_AGENT_DATA_DIR /working \
  --chdir /working --remount-ro / /bin/node /project/experiments/agent-plus-full-linux.mjs "${2:-}"
