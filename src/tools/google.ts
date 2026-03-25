/**
 * Google Calendar + Gmail integration.
 *
 * Auth: OAuth2. First run requires browser-based consent.
 * Tokens stored at ~/.jarvis/google-tokens.json and auto-refreshed.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI  (default: http://localhost:3456/oauth/callback)
 */

import { google } from "googleapis";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKENS_PATH = join(homedir(), ".jarvis", "google-tokens.json");
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3456/oauth/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

async function loadTokens(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(TOKENS_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: Record<string, unknown>): Promise<void> {
  await mkdir(join(homedir(), ".jarvis"), { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

async function getAuthedClient() {
  const auth = getOAuth2Client();
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error("Google not authenticated. Run `jarvis_google_auth` to set up OAuth.");
  }
  auth.setCredentials(tokens);

  // Auto-refresh if token is expired
  auth.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged as Record<string, unknown>);
  });

  return auth;
}

/**
 * Start OAuth flow — opens browser, waits for callback, saves tokens.
 * Returns instructions for the user.
 */
export async function googleAuth(): Promise<string> {
  const auth = getOAuth2Client();
  const authUrl = auth.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

  // Start a local HTTP server to capture the callback
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost:3456");
      if (url.pathname !== "/oauth/callback") {
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.end("No code received. Try again.");
        resolve("OAuth failed — no code received.");
        server.close();
        return;
      }

      try {
        const { tokens } = await auth.getToken(code);
        await saveTokens(tokens as Record<string, unknown>);
        res.end("<html><body><h2>Jarvis authenticated!</h2><p>You can close this tab.</p></body></html>");
        resolve(`Google OAuth complete. Tokens saved to ${TOKENS_PATH}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.end(`Error: ${msg}`);
        resolve(`OAuth error: ${msg}`);
      } finally {
        server.close();
      }
    });

    server.listen(3456, () => {
      resolve(`Open this URL in your browser to authenticate:\n\n${authUrl}\n\nWaiting for OAuth callback on port 3456...`);
    });

    // Auto-timeout after 3 minutes
    setTimeout(() => {
      server.close();
    }, 3 * 60 * 1000);
  });
}

/**
 * Get today's calendar events (next 24h).
 */
export async function calendarToday(): Promise<string> {
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: tomorrow.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return "No events in the next 24 hours.";

  const lines = events.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? "?";
    const time = e.start?.dateTime
      ? new Date(start).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", timeZone: "America/Vancouver" })
      : "All day";
    const title = e.summary ?? "(no title)";
    const location = e.location ? ` @ ${e.location}` : "";
    const meet = e.hangoutLink ? " [Meet]" : "";
    return `  ${time} — ${title}${location}${meet}`;
  });

  return `**Today's Calendar (next 24h):**\n${lines.join("\n")}`;
}

/**
 * Get upcoming calendar events for the next N days.
 */
export async function calendarUpcoming(days = 7): Promise<string> {
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return `No events in the next ${days} days.`;

  const lines = events.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? "?";
    const dt = e.start?.dateTime
      ? new Date(start).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Vancouver" })
      : new Date(start).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Vancouver" });
    const title = e.summary ?? "(no title)";
    return `  ${dt} — ${title}`;
  });

  return `**Upcoming events (${days}d):**\n${lines.join("\n")}`;
}

interface GmailMessage {
  id: string;
  snippet: string;
  from: string;
  subject: string;
  date: string;
  isUnread: boolean;
}

async function getMessageDetails(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
): Promise<GmailMessage | null> {
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = msg.data.payload?.headers ?? [];
    const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      id: messageId,
      snippet: msg.data.snippet ?? "",
      from: getHeader("From"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      isUnread: (msg.data.labelIds ?? []).includes("UNREAD"),
    };
  } catch {
    return null;
  }
}

/**
 * Triage inbox — return unread emails with action classification.
 */
export async function gmailTriage(maxEmails = 20): Promise<string> {
  const auth = await getAuthedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX", "UNREAD"],
    maxResults: maxEmails,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) return "Inbox is clear — no unread emails.";

  const details = await Promise.all(
    messages.map((m) => getMessageDetails(gmail, m.id ?? "")),
  );

  const valid = details.filter((d): d is GmailMessage => d !== null);

  const lines = valid.map((m) => {
    const date = new Date(m.date).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
    const from = m.from.replace(/<.*>/, "").trim() || m.from;
    return `  [${date}] ${from}\n    Subject: ${m.subject}\n    Preview: ${m.snippet.slice(0, 100)}`;
  });

  return `**Unread emails (${valid.length}):**\n${lines.join("\n\n")}`;
}

/**
 * Search Gmail messages.
 */
export async function gmailSearch(query: string, maxResults = 10): Promise<string> {
  const auth = await getAuthedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) return `No emails matching: ${query}`;

  const details = await Promise.all(
    messages.map((m) => getMessageDetails(gmail, m.id ?? "")),
  );

  const valid = details.filter((d): d is GmailMessage => d !== null);
  const lines = valid.map((m) => {
    const date = new Date(m.date).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
    const from = m.from.replace(/<.*>/, "").trim() || m.from;
    const unread = m.isUnread ? " [UNREAD]" : "";
    return `  [${date}]${unread} ${from} — ${m.subject}\n    ${m.snippet.slice(0, 120)}`;
  });

  return `**Gmail search: "${query}" (${valid.length} results):**\n${lines.join("\n\n")}`;
}
