/** Errors carry a process exit code and a message safe to show users (never secrets). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export class MissingKeyError extends CliError {
  constructor(envVar: string, purpose: string) {
    super(`${envVar} is not set. ${purpose} Set it in your own shell environment; browsing the catalog does not need it.`);
    this.name = 'MissingKeyError';
  }
}

/** Provider says credits, budget or plan allowance is exhausted. Never retried. */
export class QuotaError extends CliError {
  constructor(provider: string, detail: string) {
    super(`${provider}: quota or credits exhausted (${detail}). Stopping; no other provider or paid model is tried automatically.`);
    this.name = 'QuotaError';
  }
}

export class RateLimitError extends CliError {
  constructor(provider: string, retryAfterSeconds: number | null) {
    super(
      `${provider}: rate limited${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ''}. Wait and try again later.`,
    );
    this.name = 'RateLimitError';
  }
}

export class ProviderError extends CliError {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = 'ProviderError';
  }
}

export class NetworkError extends CliError {
  constructor(what: string, cause: unknown) {
    super(`Network error while ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'NetworkError';
  }
}

export class RequestCapError extends CliError {
  constructor(cap: number) {
    super(`Request cap of ${cap} reached for this command. Raise it with --max-requests or AMBASSADOR_MAX_REQUESTS if intended.`);
    this.name = 'RequestCapError';
  }
}

/** Sync/restore detected a value that changed since review. Nothing was written. */
export class ConflictError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = 'ConflictError';
  }
}
