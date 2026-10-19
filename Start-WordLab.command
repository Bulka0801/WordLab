#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Потрібен Python 3.9 або новіший: https://www.python.org/downloads/macos/"
  read -r -p "Натисни Enter, щоб закрити…"
  exit 1
fi
python3 voicebox_bridge.py
status=$?
if [ "$status" -ne 0 ]; then
  read -r -p "Натисни Enter, щоб закрити…"
fi
exit "$status"
