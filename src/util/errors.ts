/** Error types with stable exit codes for the CLI. */

export class CliError extends Error {
  readonly exitCode: number;
  /** Optional remediation hint printed after the message. */
  readonly hint: string | undefined;

  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

/** Bad flags / missing arguments / unusable input. Exit code 2. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, ...(hint === undefined ? {} : { hint }) });
  }
}

/** Authentication failed (401 after the NTLM handshake). Exit code 3. */
export class AuthError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 3, ...(hint === undefined ? {} : { hint }) });
  }
}

/** SharePoint reachable but the request failed (non-401). Exit code 4. */
export class ApiError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 4, ...(hint === undefined ? {} : { hint }) });
  }
}

/** Network/TLS/DNS failure reaching the farm. Exit code 5. */
export class NetworkError extends CliError {
  /** Underlying Node error code (ECONNRESET, ETIMEDOUT, …) when known. */
  code: string | undefined;

  constructor(message: string, hint?: string) {
    super(message, { exitCode: 5, ...(hint === undefined ? {} : { hint }) });
  }
}
