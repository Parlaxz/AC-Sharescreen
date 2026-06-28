import { execFile } from "child_process";

export type ShortcutBinding = {
  modifiers: Array<"alt" | "ctrl" | "shift" | "win">;
  key: string;
};

export interface ShortcutSendResult {
  success: boolean;
  error?: string;
  source?: "helper" | "direct";
}

export interface ShortcutHelper {
  sendShortcut: (
    modifiers: Array<"alt" | "ctrl" | "shift" | "win">,
    key: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

export function normalizeShortcutBinding(binding: ShortcutBinding): ShortcutBinding {
  return {
    modifiers: binding.modifiers
      .map((modifier) => modifier.toLowerCase() as ShortcutBinding["modifiers"][number])
      .filter((modifier, index, array) => (
        ["alt", "ctrl", "shift", "win"].includes(modifier) && array.indexOf(modifier) === index
      )),
    key: binding.key.trim().toUpperCase(),
  };
}

/**
 * Normalize an Electron accelerator string by replacing the user-facing
 * "Win" modifier with the canonical "Super" that Electron expects.
 *
 * KeyRecorder displays the Windows key as "Win" but `globalShortcut.register()`
 * only recognises "Super" (or "Meta"). This function bridges that gap.
 *
 * @example normalizeAccelerator("Win+Alt+S") → "Super+Alt+S"
 */
export function normalizeAccelerator(accel: string): string {
  return accel.replace(/\bWin\b/g, "Super");
}

export async function sendShortcutWithFallback(
  binding: ShortcutBinding,
  deps: {
    currentHelper: ShortcutHelper | null;
    ensureHelper: () => Promise<ShortcutHelper>;
    directSend: (binding: ShortcutBinding) => Promise<ShortcutSendResult>;
  },
): Promise<ShortcutSendResult> {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized.key) {
    return { success: false, error: "invalid-shortcut-key" };
  }

  let helper: ShortcutHelper | null = deps.currentHelper;
  let helperError: string | undefined;

  if (!helper) {
    try {
      helper = await deps.ensureHelper();
    } catch (error) {
      helperError = error instanceof Error ? error.message : String(error);
    }
  }

  if (helper) {
    try {
      const helperResult = await helper.sendShortcut(normalized.modifiers, normalized.key);
      if (helperResult.success) {
        return { success: true, source: "helper" };
      }
      helperError = helperResult.error ?? "helper-send-shortcut-failed";
    } catch (error) {
      helperError = error instanceof Error ? error.message : String(error);
    }
  }

  const directResult = await deps.directSend(normalized);
  if (directResult.success) {
    return { success: true, source: "direct" };
  }

  const combinedError = [helperError, directResult.error]
    .filter((value): value is string => Boolean(value))
    .join(" | ");

  return {
    success: false,
    error: combinedError || "send-shortcut-failed",
  };
}

/**
 * Build a SendKeys-format string from a ShortcutBinding.
 *
 * SendKeys format:
 *   % = Alt   ^ = Ctrl   + = Shift
 *   Special keys: {ENTER}, {TAB}, {ESC}, {F1}..{F12}, etc.
 *
 * Win modifier (⊞) is not supported by SendKeys and will be skipped with
 * a warning in the result if present. Those shortcuts require the native
 * helper.
 */
function buildSendKeysString(binding: ShortcutBinding): {
  sendKeys: string;
  notes: string[];
} {
  const notes: string[] = [];
  const modifierParts: string[] = [];

  for (const mod of binding.modifiers) {
    if (mod === "alt") modifierParts.push("%");
    else if (mod === "ctrl") modifierParts.push("^");
    else if (mod === "shift") modifierParts.push("+");
    else if (mod === "win") {
      notes.push("Win key not supported via SendKeys; native helper required");
    }
  }

  const keyMap: Record<string, string> = {
    F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}",
    F5: "{F5}", F6: "{F6}", F7: "{F7}", F8: "{F8}",
    F9: "{F9}", F10: "{F10}", F11: "{F11}", F12: "{F12}",
    ENTER: "{ENTER}", RETURN: "{ENTER}", TAB: "{TAB}",
    ESC: "{ESC}", ESCAPE: "{ESC}", SPACE: " ",
    BACKSPACE: "{BS}", DELETE: "{DEL}", INSERT: "{INS}",
    HOME: "{HOME}", END: "{END}",
    PAGEUP: "{PGUP}", PAGEDOWN: "{PGDN}",
    UP: "{UP}", DOWN: "{DOWN}", LEFT: "{LEFT}", RIGHT: "{RIGHT}",
  };

  const upperKey = binding.key.toUpperCase();
  const keyPart = keyMap[upperKey] ?? (upperKey.length === 1 ? upperKey : "");

  return {
    sendKeys: `${modifierParts.join("")}${keyPart}`,
    notes,
  };
}

export async function sendShortcutViaPowerShellSendInput(
  binding: ShortcutBinding,
): Promise<ShortcutSendResult> {
  const normalized = normalizeShortcutBinding(binding);
  const { sendKeys, notes } = buildSendKeysString(normalized);

  if (!sendKeys) {
    return { success: false, error: `unsupported-key:${normalized.key}` };
  }

  // Escape single quotes for PowerShell string literal
  const escapedKeys = sendKeys.replace(/'/g, "''");
  const psCommand = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapedKeys}')`;

  // Use -Command with the script block (more reliable than -EncodedCommand for short commands)
  return new Promise<ShortcutSendResult>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCommand],
      { timeout: 5000, windowsHide: true },
      (error) => {
        if (!error) {
          resolve({ success: true, source: "direct" });
          return;
        }

        const errMsg = notes.length > 0
          ? `${error.message} (${notes.join("; ")})`
          : error.message;

        resolve({ success: false, error: errMsg });
      },
    );
  });
}
