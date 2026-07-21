export type MadErrorCode =
  | "USAGE"
  | "CONFIG"
  | "PREFLIGHT"
  | "LOCKED"
  | "PAUSED"
  | "CANCELLED"
  | "EXECUTION";

export class MadError extends Error {
  public constructor(
    public readonly code: MadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MadError";
  }
}

export const EXIT_CODES: Readonly<Record<MadErrorCode, number>> = {
  USAGE: 2,
  CONFIG: 3,
  PREFLIGHT: 4,
  LOCKED: 5,
  PAUSED: 20,
  CANCELLED: 21,
  EXECUTION: 30,
};
