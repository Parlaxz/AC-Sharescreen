import { app } from "electron";
import path from "path";
import fs from "fs";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  generation?: number;
  peerIdShort?: string;
  details?: Record<string, unknown>;
}

const REDACTED_KEYS = [
  "token",
  "password",
  "authorization",
  "secret",
  "streamId",
  "viewerUrl",
];

/**
 * Structured file logger with rotation.
 *
 * Logs are written as newline-delimited JSON to the userData/logs directory.
 * Files rotate at 5 MiB each, keeping up to 5 rotated files.
 * Sensitive fields are automatically redacted from detail objects.
 */
export class LogManager {
  private logDir: string;
  private currentFile: string;
  private currentSize = 0;
  private maxFiles = 5;
  private maxSize = 5 * 1024 * 1024; // 5 MiB

  constructor() {
    this.logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
    this.currentFile = path.join(this.logDir, "screenlink-0.log");
    this.rotateIfNeeded();
  }

  private rotateIfNeeded(): void {
    try {
      if (fs.existsSync(this.currentFile)) {
        this.currentSize = fs.statSync(this.currentFile).size;
      }
    } catch {
      this.currentSize = 0;
    }
  }

  private rotate(): void {
    // Remove the oldest file
    const lastFile = path.join(this.logDir, `screenlink-${this.maxFiles - 1}.log`);
    try {
      fs.unlinkSync(lastFile);
    } catch {
      // Ignore if it doesn't exist
    }

    // Shift remaining files: N -> N+1
    for (let i = this.maxFiles - 2; i >= 0; i--) {
      const oldPath = path.join(this.logDir, `screenlink-${i}.log`);
      const newPath = path.join(this.logDir, `screenlink-${i + 1}.log`);
      try {
        fs.renameSync(oldPath, newPath);
      } catch {
        // Ignore missing files
      }
    }

    this.currentFile = path.join(this.logDir, "screenlink-0.log");
    this.currentSize = 0;
  }

  /**
   * Write a structured log entry.
   */
  log(
    level: LogLevel,
    component: string,
    event: string,
    details?: Record<string, unknown>,
  ): void {
    this.rotateIfNeeded();

    if (this.currentSize >= this.maxSize) {
      this.rotate();
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      event,
      details: details ? this.redact(details) : undefined,
    };

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.currentFile, line, "utf-8");
    this.currentSize += Buffer.byteLength(line);
  }

  /**
   * Recursively redact sensitive keys from an object.
   */
  private redact(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (REDACTED_KEYS.some((k) => key.toLowerCase().includes(k))) {
        result[key] = "[REDACTED]";
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.redact(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Get sorted list of log file paths (newest first).
   */
  getLogFiles(): string[] {
    const files: string[] = [];
    for (let i = 0; i < this.maxFiles; i++) {
      const p = path.join(this.logDir, `screenlink-${i}.log`);
      if (fs.existsSync(p)) {
        files.push(p);
      }
    }
    return files;
  }

  /**
   * Read and concatenate all log files into a single string.
   */
  readAllLogs(): string {
    return this.getLogFiles()
      .map((f) => fs.readFileSync(f, "utf-8"))
      .join("\n");
  }
}
