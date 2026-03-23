export type WebsearchBackendId = "openai-codex" | "anthropic" | "gemini";
export type WebsearchAuthSource = "pi" | "firefox" | "chromium";
export type WebsearchBrowserFamily = "firefox" | "chromium";
export type WebsearchRouteId =
  | "pi:openai-codex"
  | "pi:anthropic"
  | "pi:gemini"
  | "firefox:openai-codex"
  | "firefox:gemini"
  | "chromium:openai-codex"
  | "chromium:gemini";

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}

export interface WebsearchConfig {
  routes: WebsearchRouteId[];
  profiles: Partial<Record<WebsearchBrowserFamily, string>>;
}

export interface BrowserProfile {
  family: WebsearchBrowserFamily;
  browserName: string;
  profileName: string;
  profilePath: string;
}

export interface BrowserSession {
  profile: BrowserProfile;
  cookies: BrowserCookie[];
}

export interface WebsearchSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebsearchResult {
  backend: WebsearchBackendId;
  authSource: WebsearchAuthSource;
  browserName?: string;
  profile?: string;
  accountLabel?: string;
  answer: string;
  sources: WebsearchSource[];
}
