/**
 * WINDOWS STARTUP for Always-On Monitoring: a Task Scheduler definition that
 * starts ONLY the monitoring supervisor (`monitoring:always-on run`) when the
 * operator logs on. The supervisor then owns its monitoring children. Nothing
 * here starts Account A or Account B, and nothing here REGISTERS a task: this
 * module builds the XML and the exact commands; the operator registers it
 * later, deliberately.
 *
 * Choices, each for a reason:
 *  - LOGON trigger as the interactive user (not a SYSTEM boot task): the
 *    supervisor needs that user's %LOCALAPPDATA% (runtime state, env files,
 *    scanner data) — a SYSTEM task would see a different profile.
 *  - A one-minute delay: Docker Desktop (Postgres, Redis) and the network come
 *    up first; the supervisor also blocks and backs off on its own.
 *  - `cmd /d /c pnpm -C <repo> ...` directly — no script path with spaces to
 *    quote. The repository path must be a plain path (validated).
 *  - IgnoreNew for a second instance (the supervisor refuses a second one on
 *    its own anyway), no execution time limit, no battery stop, and a bounded
 *    restart-on-failure if the supervisor itself crashes.
 *  - UTF-16 with BOM: what `schtasks /Create /XML` reliably accepts.
 */

export interface StartupTaskInput {
  readonly taskName: string;
  readonly repoRoot: string;
  /** The `run` arguments, already validated by the CLI parser. */
  readonly runArgs: readonly string[];
  /** DOMAIN\user of the operator (names only; from the environment), or null to let schtasks use the registering user. */
  readonly userId: string | null;
}

export class StartupTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupTaskError";
  }
}

const PLAIN = /^[A-Za-z]:\\[^\s"&|<>^%!]*$/;

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function startupTaskArguments(input: Pick<StartupTaskInput, "repoRoot" | "runArgs">): string {
  if (!PLAIN.test(input.repoRoot)) throw new StartupTaskError("the repository path must be a plain absolute Windows path (no spaces or shell characters) for an unattended start");
  for (const arg of input.runArgs) if (/[\s"&|<>^%!]/.test(arg)) throw new StartupTaskError("a run argument contains a space or a shell character");
  return ["/d", "/c", "pnpm", "-C", input.repoRoot, "--filter", "@trading-alert-dashboard/backend", "monitoring:always-on", "run", ...input.runArgs].join(" ");
}

export function startupTaskXml(input: StartupTaskInput): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(input.taskName)) throw new StartupTaskError("the task name must be letters, digits, - or _");
  const args = startupTaskArguments(input);
  const principalUser = input.userId === null ? "" : `\n      <UserId>${xmlEscape(input.userId)}</UserId>`;
  const triggerUser = input.userId === null ? "" : `\n      <UserId>${xmlEscape(input.userId)}</UserId>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Always-On Monitoring V1 — MONITORING ONLY, NO ACCOUNT EXECUTION, NATIVE EXECUTION HARD-DISABLED. Starts the monitoring supervisor (generic backend, Native scanner, emitter, planner). Never starts Account A or Account B.</Description>
    <URI>\\${xmlEscape(input.taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
      <Delay>PT1M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalUser}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT5M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(input.repoRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16LE with a BOM, as `schtasks /XML` expects. */
export function startupTaskXmlBytes(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace(/\r?\n/g, "\r\n"), "utf16le")]);
}

/** The exact operator commands (PowerShell). Printed, never executed by this repository. */
export function startupTaskCommands(taskName: string, xmlPath: string): string[] {
  return [
    `schtasks /Create /TN "${taskName}" /XML "${xmlPath}"`,
    `schtasks /Query /TN "${taskName}" /V /FO LIST`,
    `schtasks /Run /TN "${taskName}"        # optional: start it now instead of at the next logon`,
    `schtasks /End /TN "${taskName}"        # stops only the task's console; prefer: pnpm --filter @trading-alert-dashboard/backend monitoring:always-on stop`,
    `schtasks /Delete /TN "${taskName}" /F  # remove the logon start`,
  ];
}
