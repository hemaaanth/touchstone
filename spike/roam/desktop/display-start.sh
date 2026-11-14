#!/bin/sh
# Adapted from BB sandboxes docker/display-start.sh. MIT; see LICENSE.bb.
set -eu
[ "${TOUCHSTONE_ROAM_RUNTIME:-}" = 1 ] || { echo 'Remote runtime only' >&2; exit 1; }
state=/run/touchstone
install -d -m 700 "$state"
# Serialize starts without inspecting any unrelated processes or environments.
exec 9>"$state/display.lock"
flock 9
ready() { DISPLAY=:99 xdpyinfo >/dev/null 2>&1; }
case "${1:-start}" in
  status) ready; exit $? ;;
  start) ;;
  *) echo 'Usage: display-start.sh [start|status]' >&2; exit 2 ;;
esac
if ready; then
  [ "$(DISPLAY=:99 xdpyinfo | awk '/dimensions:/ {print $2}')" = 1920x1080 ] || { echo 'Old geometry; restart machine' >&2; exit 1; }
else
  # Xvfb owns :99 for this image; stale locks are from a prior container start.
  rm -f /tmp/.X99-lock
  setsid Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -shmem >>"$state/display.log" 2>&1 </dev/null 9>&- &
  elapsed=0
  while ! ready; do
    elapsed=$((elapsed + 1))
    [ "$elapsed" -lt 20 ] || { echo 'Xvfb did not start' >&2; exit 1; }
    sleep 1
  done
fi
pid=$(cat "$state/openbox.pid" 2>/dev/null || true)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  # Normal browser windows fill the fixed screen. Dialogs retain their size.
  printf '%s\n' '<?xml version="1.0"?><openbox_config xmlns="http://openbox.org/3.4/rc"><applications><application type="normal"><maximized>yes</maximized></application></applications></openbox_config>' >"$state/openbox.xml"
  DISPLAY=:99 setsid openbox --sm-disable --config-file "$state/openbox.xml" >>"$state/display.log" 2>&1 </dev/null 9>&- &
  printf '%s\n' "$!" >"$state/openbox.pid"
fi
printf 'export DISPLAY=:99\n'
