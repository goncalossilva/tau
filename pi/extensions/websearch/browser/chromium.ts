import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import type { BrowserCookie, BrowserProfile } from "../types.js";
import { withSqliteSnapshot } from "./sqlite.js";

interface ChromiumBrowserConfig {
  name: string;
  baseDir: string;
  keychainService?: string;
  keychainAccount?: string;
  secretToolApp?: string;
}

const passwordCache = new Map<string, string | null>();

const MACOS_BROWSER_CONFIGS: ChromiumBrowserConfig[] = [
  {
    name: "Chromium",
    baseDir: path.join(os.homedir(), "Library", "Application Support", "Chromium"),
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
  },
  {
    name: "Chrome",
    baseDir: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  },
  {
    name: "Brave",
    baseDir: path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
  },
  {
    name: "Edge",
    baseDir: path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge"),
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
  },
];

const LINUX_BROWSER_CONFIGS: ChromiumBrowserConfig[] = [
  {
    name: "Chromium",
    baseDir: path.join(os.homedir(), ".config", "chromium"),
    secretToolApp: "chromium",
  },
  {
    name: "Chrome",
    baseDir: path.join(os.homedir(), ".config", "google-chrome"),
    secretToolApp: "chrome",
  },
  {
    name: "Brave",
    baseDir: path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser"),
    secretToolApp: "brave",
  },
  {
    name: "Edge",
    baseDir: path.join(os.homedir(), ".config", "microsoft-edge"),
    secretToolApp: "microsoft-edge",
  },
];

function browserConfigs(): ChromiumBrowserConfig[] {
  if (process.platform === "darwin") return MACOS_BROWSER_CONFIGS;
  if (process.platform === "linux") return LINUX_BROWSER_CONFIGS;
  return [];
}

export function discoverChromiumProfiles(preferredProfileName?: string): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];

  for (const config of browserConfigs()) {
    if (!existsSync(config.baseDir)) continue;

    const candidates = ["Default", ...discoverProfileDirectories(config.baseDir)];
    const seen = new Set<string>();
    for (const directoryName of candidates) {
      if (!directoryName || seen.has(directoryName)) continue;
      seen.add(directoryName);

      const profilePath = path.join(config.baseDir, directoryName);
      const cookiesPath = path.join(profilePath, "Cookies");
      if (!existsSync(cookiesPath)) continue;

      profiles.push({
        family: "chromium",
        browserName: config.name,
        profileName: directoryName,
        profilePath,
      });
    }
  }

  const sorted = profiles.sort((left, right) => {
    const leftPreferred = isPreferredChromiumProfile(left, preferredProfileName);
    const rightPreferred = isPreferredChromiumProfile(right, preferredProfileName);
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;

    if (left.browserName !== right.browserName) {
      return browserPriority(left.browserName) - browserPriority(right.browserName);
    }

    return left.profileName.localeCompare(right.profileName);
  });

  return preferredProfileName
    ? sorted.filter((profile) => isPreferredChromiumProfile(profile, preferredProfileName))
    : sorted;
}

function browserPriority(browserName: string): number {
  const order = ["Chromium", "Chrome", "Brave", "Edge"];
  const index = order.indexOf(browserName);
  return index === -1 ? order.length : index;
}

function isPreferredChromiumProfile(profile: BrowserProfile, preferredProfileName?: string): boolean {
  if (!preferredProfileName) return false;
  return profile.profileName === preferredProfileName;
}

function discoverProfileDirectories(baseDir: string): string[] {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name === "Default" || /^Profile\s+\d+$/.test(name));
  } catch {
    return [];
  }
}

export function loadChromiumCookies(profile: BrowserProfile): BrowserCookie[] {
  const browserConfig = browserConfigs().find((config) => profile.profilePath.startsWith(config.baseDir));
  if (!browserConfig) return [];

  const password = readBrowserPassword(browserConfig);
  if (!password) return [];

  const keyMaterial = pbkdf2Sync(password, "saltysalt", process.platform === "darwin" ? 1003 : 1, 16, "sha1");
  const cookiesPath = path.join(profile.profilePath, "Cookies");
  if (!existsSync(cookiesPath)) return [];

  try {
    return withSqliteSnapshot(cookiesPath, "websearch-chromium", (tempDbPath) => {
      const db = new DatabaseSync(tempDbPath, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT host_key, name, value, encrypted_value, path, is_secure FROM cookies ORDER BY host_key ASC, path DESC, expires_utc DESC",
        ).all() as Array<Record<string, unknown>>;

        const cookies: BrowserCookie[] = [];
        const seen = new Set<string>();
        let sawEncryptedCookie = false;
        let failedDecrypt = false;
        for (const row of rows) {
          const name = typeof row.name === "string" ? row.name : null;
          const domain = typeof row.host_key === "string" ? row.host_key : null;
          const cookiePath = typeof row.path === "string" ? row.path : "/";
          if (!name || !domain) continue;

          const key = `${name}\u0000${domain}\u0000${cookiePath}`;
          if (seen.has(key)) continue;

          const plainValue = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
          if (plainValue !== null) {
            seen.add(key);
            cookies.push({
              name,
              value: plainValue,
              domain,
              path: cookiePath,
              secure: Boolean(row.is_secure),
            });
            continue;
          }

          if (!(row.encrypted_value instanceof Uint8Array)) continue;
          sawEncryptedCookie = true;
          const decrypted = decryptCookieValue(row.encrypted_value, keyMaterial, domain);
          if (decrypted !== null) {
            seen.add(key);
            cookies.push({
              name,
              value: decrypted,
              domain,
              path: cookiePath,
              secure: Boolean(row.is_secure),
            });
          } else {
            failedDecrypt = true;
          }
        }

        if (cookies.length === 0 && sawEncryptedCookie && failedDecrypt) {
          throw new Error(`Could not decrypt ${profile.browserName} cookies.`);
        }

        return cookies;
      } finally {
        db.close();
      }
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Could not read ${profile.browserName} cookies.`);
  }
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, hostKey: string | null): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length < 3) return null;

  const prefix = buffer.subarray(0, 3).toString("utf8");
  if (prefix !== "v10") return null;

  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    const decrypted = stripPkcs7Padding(Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]));
    const normalized = stripHostKeyDigest(decrypted, hostKey);
    return normalized.toString("utf8").replace(/^\x00+/, "");
  } catch {
    return null;
  }
}

function stripPkcs7Padding(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  const padding = buffer[buffer.length - 1];
  if (padding <= 0 || padding > 16) return buffer;
  return buffer.subarray(0, buffer.length - padding);
}

function stripHostKeyDigest(buffer: Buffer, hostKey: string | null): Buffer {
  if (!hostKey || buffer.length <= 32) return buffer;

  const digest = createHash("sha256").update(hostKey).digest();
  return buffer.subarray(0, 32).equals(digest) ? buffer.subarray(32) : buffer;
}

function readBrowserPassword(config: ChromiumBrowserConfig): string | null {
  const cacheKey = `${config.name}:${config.baseDir}`;
  if (passwordCache.has(cacheKey)) {
    return passwordCache.get(cacheKey) ?? null;
  }

  let password: string | null = null;
  if (process.platform === "darwin") {
    if (!config.keychainAccount || !config.keychainService) return null;
    password = readMacKeychainPassword(config.name, config.keychainAccount, config.keychainService);
  } else if (process.platform === "linux") {
    password = readLinuxPassword(config.secretToolApp);
  }

  if (password) {
    passwordCache.set(cacheKey, password);
  }
  return password;
}

function readMacKeychainPassword(browserName: string, account: string, service: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-a", account, "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    throw new Error(`Could not read ${browserName} cookie decryption password from Keychain.`);
  }
}

function readLinuxPassword(secretToolApp?: string): string | null {
  if (!secretToolApp) return "peanuts";

  try {
    return execFileSync("secret-tool", ["lookup", "application", secretToolApp], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "peanuts";
  } catch {
    return "peanuts";
  }
}

