/**
 * What this agent's Ardent bridge supports. `studio: 1` means session-open,
 * session-bound task submission, unbuffered task streams and streamed artifacts.
 * `studio: 2` adds missions, task pause and resume, previews, development
 * history and notes, artifact manifests and session contexts (Ardent 2.2.0).
 * `studio: 3` adds skill-install, which installs a HiveSkills release onto a profile.
 *
 * The ping route reports this level and the server gates Studio actions on it, and the
 * Ardent installation report carries it, so both read this one constant.
 */
export const ARDENT_AGENT_CAPABILITIES = { studio: 3 } as const;
