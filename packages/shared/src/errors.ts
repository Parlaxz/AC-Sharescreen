/**
 * Domain error classes for ScreenLink.
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

export class ScreenLinkError extends Error {
  public readonly code: string;
  public readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "ScreenLinkError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class ValidationError extends ScreenLinkError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class CompatibilityError extends ScreenLinkError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("COMPATIBILITY_ERROR", message, details);
    this.name = "CompatibilityError";
  }
}

export class ProtocolError extends ScreenLinkError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("PROTOCOL_ERROR", message, details);
    this.name = "ProtocolError";
  }
}
