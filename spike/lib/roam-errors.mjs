// Only errors created here may cross the tool gate. Remote text stays private.
const trusted = new WeakSet();
const messages = Object.freeze({
  ROAM_SHELL_OUTCOME_UNKNOWN: "The command outcome is unknown. It was not replayed. The next shell call will attempt recovery before running a new command.",
  ROAM_SHELL_RECOVERY_FAILED: "Shell recovery could not verify that previous managed processes stopped. No new command ran. Retry a later shell call.",
  ROAM_MACHINE_UNAVAILABLE: "The remote machine could not be reached or opened. Retry a later call.",
  ROAM_EGRESS_UNAVAILABLE: "The request log did not start. No log, no shell. Retry a later call.",
  ROAM_SESSION_SNAPSHOT_UNAVAILABLE: "The session snapshot is unavailable. No candidate was submitted.",
});
export function roamError(code) {
  if (!Object.hasOwn(messages, code)) throw new Error("Unknown roam error code");
  const error = Object.assign(new Error(`${code}: ${messages[code]}`), { code });
  trusted.add(error);
  return error;
}
export const publicRoamError = (error) => trusted.has(error) ? error.message : "ROAM_RUN_FAILED";
