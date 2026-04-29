import type { BrowserCookie, WebsearchSource } from "./types.js";

export const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0";

export function buildCookieHeader(url: string, cookies: BrowserCookie[]): string {
  return cookiesForUrl(url, cookies)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function hasCookie(url: string, cookies: BrowserCookie[], name: string): boolean {
  return cookiesForUrl(url, cookies).some((cookie) => cookie.name === name);
}

function cookiesForUrl(url: string, cookies: BrowserCookie[]): BrowserCookie[] {
  const target = new URL(url);
  const requestPath = target.pathname || "/";

  return [...cookies]
    .filter((cookie) => {
      return (
        cookie.value.length > 0 &&
        matchesCookieDomain(target.hostname, cookie.domain) &&
        matchesCookiePath(requestPath, cookie.path) &&
        (!cookie.secure || target.protocol === "https:")
      );
    })
    .sort((left, right) => right.path.length - left.path.length);
}

function matchesCookieDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();

  if (normalizedDomain.startsWith(".")) {
    const suffix = normalizedDomain.slice(1);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }

  return normalizedHost === normalizedDomain;
}

function matchesCookiePath(requestPath: string, cookiePath: string): boolean {
  const normalizedCookiePath = cookiePath || "/";
  if (requestPath === normalizedCookiePath) return true;
  if (!requestPath.startsWith(normalizedCookiePath)) return false;
  if (normalizedCookiePath.endsWith("/")) return true;
  return requestPath.charAt(normalizedCookiePath.length) === "/";
}

export function browserHeaders(options: {
  cookieHeader?: string;
  origin: string;
  referer: string;
  accept?: string;
  contentType?: string;
  authorization?: string;
  extra?: Record<string, string | undefined>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_BROWSER_USER_AGENT,
    Accept: options.accept ?? "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: options.referer,
    Origin: options.origin,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
  };

  if (options.cookieHeader) headers.Cookie = options.cookieHeader;
  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.authorization) headers.Authorization = options.authorization;

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if (value) headers[key] = value;
    }
  }

  return headers;
}

export function normalizeSourceTitle(url: string, title?: string | null): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;

  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function extractMarkdownSources(text: string): WebsearchSource[] {
  const sources: WebsearchSource[] = [];
  const seen = new Set<string>();

  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const url = match[2];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: normalizeSourceTitle(url, match[1]), url });
  }

  const urlPattern = /https?:\/\/[^\s)\]}>,]+/g;
  for (const match of text.matchAll(urlPattern)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: normalizeSourceTitle(url), url });
  }

  return sources;
}

export function dedupeSources(sources: WebsearchSource[]): WebsearchSource[] {
  const deduped = new Map<string, WebsearchSource>();

  for (const source of sources) {
    if (!source.url) continue;
    if (!deduped.has(source.url)) {
      deduped.set(source.url, {
        title: normalizeSourceTitle(source.url, source.title),
        url: source.url,
        snippet: source.snippet,
      });
    }
  }

  return [...deduped.values()];
}

export function renderSearchResultMarkdown(answer: string, sources: WebsearchSource[]): string {
  const trimmedAnswer = answer.trim();
  if (sources.length === 0) return trimmedAnswer;

  const embeddedSources = new Set(
    extractMarkdownSources(trimmedAnswer).map((source) => source.url),
  );
  const extraSources = sources.filter((source) => !embeddedSources.has(source.url));
  if (extraSources.length === 0) return trimmedAnswer;

  const lines = [trimmedAnswer, "", "Sources:"];
  for (const source of extraSources) {
    lines.push(`- [${normalizeSourceTitle(source.url, source.title)}](${source.url})`);
  }

  return lines.join("\n").trim();
}
