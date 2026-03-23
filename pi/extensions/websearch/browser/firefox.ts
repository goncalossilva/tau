import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import type { BrowserCookie, BrowserProfile } from "../types.js";
import { withSqliteSnapshot } from "./sqlite.js";

function firefoxBaseDir(): string | null {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Firefox");
  }

  if (process.platform === "linux") {
    return path.join(os.homedir(), ".mozilla", "firefox");
  }

  return null;
}

function parseIni(text: string): Array<Record<string, string>> {
  const sections: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = { __section: sectionMatch[1] ?? "" };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    current[key] = value;
  }

  return sections;
}

export function discoverFirefoxProfiles(preferredProfileName?: string): BrowserProfile[] {
  const baseDir = firefoxBaseDir();
  if (!baseDir) return [];

  const profilesIniPath = path.join(baseDir, "profiles.ini");

  let sections: Array<Record<string, string>> = [];
  try {
    sections = parseIni(readFileSync(profilesIniPath, "utf8"));
  } catch {
    return [];
  }

  const profiles: BrowserProfile[] = [];
  for (const section of sections) {
    if (!section.__section?.startsWith("Profile")) continue;
    const profilePathValue = section.Path;
    if (!profilePathValue) continue;

    const profilePath = section.IsRelative === "1"
      ? path.join(baseDir, profilePathValue)
      : profilePathValue;
    const cookiesPath = path.join(profilePath, "cookies.sqlite");
    if (!existsSync(cookiesPath)) continue;

    profiles.push({
      family: "firefox",
      browserName: "Firefox",
      profileName: section.Name?.trim() || path.basename(profilePath),
      profilePath,
    });
  }

  const sorted = profiles.sort((left, right) => {
    const leftPreferred = isPreferredFirefoxProfile(left, preferredProfileName);
    const rightPreferred = isPreferredFirefoxProfile(right, preferredProfileName);
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    return left.profileName.localeCompare(right.profileName);
  });

  return preferredProfileName
    ? sorted.filter((profile) => isPreferredFirefoxProfile(profile, preferredProfileName))
    : sorted;
}

function isPreferredFirefoxProfile(profile: BrowserProfile, preferredProfileName?: string): boolean {
  if (!preferredProfileName) return false;
  return (
    profile.profileName === preferredProfileName ||
    path.basename(profile.profilePath) === preferredProfileName
  );
}

export function loadFirefoxCookies(profile: BrowserProfile): BrowserCookie[] {
  const cookiesPath = path.join(profile.profilePath, "cookies.sqlite");
  if (!existsSync(cookiesPath)) return [];

  try {
    return withSqliteSnapshot(cookiesPath, "websearch-firefox", (tempDbPath) => {
      const db = new DatabaseSync(tempDbPath, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT name, value, host, path, isSecure FROM moz_cookies ORDER BY host ASC, path DESC, expiry DESC",
        ).all() as Array<Record<string, unknown>>;

        const cookies: BrowserCookie[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const name = typeof row.name === "string" ? row.name : null;
          const value = typeof row.value === "string" ? row.value : null;
          const domain = typeof row.host === "string" ? row.host : null;
          const cookiePath = typeof row.path === "string" ? row.path : "/";
          if (!name || value === null || !domain) continue;

          const key = `${name}\u0000${domain}\u0000${cookiePath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cookies.push({
            name,
            value,
            domain,
            path: cookiePath,
            secure: Boolean(row.isSecure),
          });
        }

        return cookies;
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error("Could not read Firefox cookies.");
      } finally {
        db.close();
      }
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Could not snapshot Firefox cookies.");
  }
}
