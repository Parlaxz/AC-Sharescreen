import { safeStorage } from "electron";

/**
 * Wrapper around Electron's safeStorage API for encrypting and decrypting
 * sensitive data (e.g., host tokens, viewer tokens).
 *
 * On supported platforms (macOS Keychain, Windows DPAPI, Linux libsecret),
 * encryption keys are managed by the OS.
 */
export class SecureStore {
  /**
   * Returns true if the OS key storage is available.
   */
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Encrypt a plaintext string. Returns null if encryption is unavailable.
   */
  encrypt(plaintext: string): Buffer | null {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(plaintext);
  }

  /**
   * Decrypt an encrypted buffer back to a string.
   * Returns null if decryption fails (e.g., wrong machine, corrupt data).
   */
  decrypt(encrypted: Buffer): string | null {
    try {
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }
}
