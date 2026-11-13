// Shared exit-code helper for the Web pack's locally-built scanner images (ffuf,
// arjun, and any later HTTP tool). These tools run through runTool(), which
// resolves { code, stdout, stderr, timedOut } and never rejects.
//
// Failing closed starts with never guessing from an exit code. classifyCode()
// reads the container's exit code: 0 is a normal finish; a timeout shows up as
// 124 (GNU coreutils `timeout`), 143 (busybox `timeout`, SIGTERM) or 137
// (SIGKILL); anything else is an error. A tool with a documented "issues found"
// code (not the case for ffuf or arjun, both of which exit 0) must special-case
// that code itself.
//
// Stopping a hung container is NOT this file's job and is deliberately not done
// here: runTool()/runDocker() in lib/wrap.mjs owns the timeout kill (a named
// container plus `docker rm -f`, landing via a shared commit) and sets
// timedOut:true. Tool code must treat timedOut:true as unavailable with a
// reason; isTimeout() folds that flag together with the timeout exit codes.

// Classify a container exit code. Returns "ok" | "timeout" | "error".
export function classifyCode(code) {
  if (code === 0) return "ok";
  if (code === 124 || code === 137 || code === 143) return "timeout";
  return "error";
}

// True when a run was stopped by its timeout rather than finishing: either
// runTool flagged timedOut, or the exit code is one a timeout produces.
export function isTimeout(code, timedOut) {
  return Boolean(timedOut) || classifyCode(code) === "timeout";
}
