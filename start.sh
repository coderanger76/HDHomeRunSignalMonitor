#!/bin/bash
# HDHomeRun Signal Monitor - launcher.  Run with:  ./start.sh
cd "$(dirname "$0")" || exit 1

if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  echo
  echo "Python 3 is not installed yet."
  echo "If a window just popped up asking to install the 'command line developer tools', click Install,"
  echo "wait for it to finish (5-15 minutes), then run ./start.sh again."
  echo "If no window appeared, type:   xcode-select --install"
  echo
  exit 1
fi

echo "Starting the HDHomeRun Signal Monitor ..."
if [ -n "$HDHR_NO_OPEN" ]; then exec python3 -u server.py "$@"; else exec python3 -u server.py --open "$@"; fi
