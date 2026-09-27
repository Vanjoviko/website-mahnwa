/** Sumber menolak akses otomatis. Job harus berhenti (status BLOCKED), tanpa bypass. */
export class BlockedError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = "BlockedError";
  }
}

/** robots.txt melarang URL ini untuk user-agent kita. */
export class RobotsDisallowedError extends BlockedError {
  constructor(url: string) {
    super("Dilarang oleh robots.txt", url);
    this.name = "RobotsDisallowedError";
  }
}

/** Source belum berstatus APPROVED. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
