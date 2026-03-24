/**
 * iMCP — iMessage, Contacts, Reminders, and Weather via native macOS.
 *
 * iMessage + Contacts + Reminders: AppleScript via osascript.
 * Weather: wttr.in JSON API (no key required).
 *
 * Permissions required:
 *   - Full Disk Access (for iMessage chat.db) OR Messages AppleScript access
 *   - Contacts access (System Preferences > Privacy > Contacts)
 *   - Reminders access (System Preferences > Privacy > Reminders)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

async function osascript(script: string): Promise<string> {
  // Write to temp file to avoid quoting nightmares with complex scripts
  const escaped = script.replace(/\\/g, "\\\\");
  const { stdout } = await execAsync(`osascript << 'OSASCRIPT_EOF'\n${script}\nOSASCRIPT_EOF`, {
    timeout: 15_000,
  });
  void escaped; // suppress unused warning
  return stdout.trim();
}

// ── iMessage ────────────────────────────────────────────────────────────────

/**
 * List recent iMessage/SMS conversations (last N chats).
 */
export async function iMessageGetChats(limit = 10): Promise<string> {
  const script = `
tell application "Messages"
  set chatList to {}
  set allChats to chats
  set chatCount to count of allChats
  set maxChats to ${limit}
  if chatCount < maxChats then set maxChats to chatCount
  repeat with i from 1 to maxChats
    set aChat to item i of allChats
    try
      set chatName to name of aChat
    on error
      set chatName to "Unknown"
    end try
    set end of chatList to chatName
  end repeat
  return chatList as text
end tell
`;
  try {
    const result = await osascript(script);
    if (!result) return "No chats found (Messages may not be running).";
    const chats = result.split(", ").map((c, i) => `${i + 1}. ${c}`);
    return `## Recent Chats (${chats.length})\n\n${chats.join("\n")}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to get chats: ${msg}\n\nEnsure Messages app has Automation permission in System Settings > Privacy & Security > Automation.`;
  }
}

/**
 * Get recent messages from a contact or group chat.
 */
export async function iMessageGetMessages(contact: string, limit = 10): Promise<string> {
  const script = `
tell application "Messages"
  set targetChat to missing value
  repeat with aChat in chats
    try
      if name of aChat contains "${contact.replace(/"/g, '\\"')}" then
        set targetChat to aChat
        exit repeat
      end if
    end try
  end repeat

  if targetChat is missing value then
    return "CHAT_NOT_FOUND"
  end if

  set msgList to {}
  set allMsgs to messages of targetChat
  set msgCount to count of allMsgs
  set startIdx to msgCount - ${limit} + 1
  if startIdx < 1 then set startIdx to 1

  repeat with i from startIdx to msgCount
    set aMsg to item i of allMsgs
    try
      set msgText to content of aMsg
      set msgDate to date string of date sent of aMsg
      try
        set msgSender to handle of sender of aMsg
      on error
        set msgSender to "me"
      end try
      set end of msgList to msgSender & " [" & msgDate & "]: " & msgText
    end try
  end repeat

  return msgList as text
end tell
`;
  try {
    const result = await osascript(script);
    if (result === "CHAT_NOT_FOUND") return `No chat found matching "${contact}".`;
    if (!result) return "No messages found.";
    return `## Messages with ${contact}\n\n${result.split(", ").join("\n")}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to get messages: ${msg}`;
  }
}

/**
 * Send an iMessage to a contact (phone number, email, or name).
 */
export async function iMessageSend(recipient: string, message: string): Promise<string> {
  const safeMsg = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeRecipient = recipient.replace(/"/g, '\\"');

  const script = `
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${safeRecipient}" of targetService
  send "${safeMsg}" to targetBuddy
end tell
`;
  try {
    await osascript(script);
    return `Sent to ${recipient}: "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to send: ${msg}\n\nNote: recipient must be an iMessage-capable handle (phone/email).`;
  }
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/**
 * Search Contacts by name. Returns name, phone, email.
 */
export async function contactsSearch(query: string): Promise<string> {
  const safeQuery = query.replace(/"/g, '\\"');
  const script = `
tell application "Contacts"
  set results to {}
  set allPeople to people whose name contains "${safeQuery}"
  repeat with aPerson in allPeople
    set personName to name of aPerson

    set phoneStr to ""
    if (count of phones of aPerson) > 0 then
      set phoneStr to value of first phone of aPerson
    end if

    set emailStr to ""
    if (count of emails of aPerson) > 0 then
      set emailStr to value of first email of aPerson
    end if

    set end of results to personName & " | " & phoneStr & " | " & emailStr
  end repeat
  return results as text
end tell
`;
  try {
    const result = await osascript(script);
    if (!result) return `No contacts found matching "${query}".`;
    const contacts = result.split(", ").map((c, i) => {
      const [name, phone, email] = c.split(" | ");
      return `${i + 1}. **${name}**${phone ? ` — ${phone}` : ""}${email ? ` — ${email}` : ""}`;
    });
    return `## Contacts matching "${query}"\n\n${contacts.join("\n")}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to search contacts: ${msg}\n\nEnsure Contacts has Automation permission in System Settings > Privacy & Security > Automation.`;
  }
}

// ── Reminders ────────────────────────────────────────────────────────────────

/**
 * Get reminders — optionally filtered by list name. Returns incomplete reminders.
 */
export async function remindersGet(listName?: string): Promise<string> {
  const listFilter = listName
    ? `list "${listName.replace(/"/g, '\\"')}"`
    : "every list";

  const script = `
tell application "Reminders"
  set reminderList to {}
  set targetLists to ${listFilter}

  if class of targetLists is list then
    repeat with aList in targetLists
      repeat with aReminder in (reminders of aList whose completed is false)
        set rName to name of aReminder
        set rDue to ""
        try
          set rDue to " [due: " & date string of due date of aReminder & "]"
        end try
        set rList to name of aList
        set end of reminderList to rList & ": " & rName & rDue
      end repeat
    end repeat
  else
    repeat with aReminder in (reminders of targetLists whose completed is false)
      set rName to name of aReminder
      set rDue to ""
      try
        set rDue to " [due: " & date string of due date of aReminder & "]"
      end try
      set end of reminderList to rName & rDue
    end repeat
  end if

  return reminderList as text
end tell
`;
  try {
    const result = await osascript(script);
    if (!result) return listName ? `No reminders in "${listName}".` : "No incomplete reminders found.";
    const items = result.split(", ").map((r, i) => `${i + 1}. ${r}`);
    const header = listName ? `## Reminders — ${listName}` : "## All Reminders";
    return `${header}\n\n${items.join("\n")}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to get reminders: ${msg}\n\nEnsure Reminders has Automation permission in System Settings > Privacy & Security > Automation.`;
  }
}

/**
 * Create a new reminder.
 */
export async function remindersCreate(
  title: string,
  listName = "Reminders",
  dueDateStr?: string,
): Promise<string> {
  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeList = listName.replace(/"/g, '\\"');
  const duePart = dueDateStr
    ? `set due date of newReminder to date "${dueDateStr.replace(/"/g, '\\"')}"`
    : "";

  const script = `
tell application "Reminders"
  set targetList to list "${safeList}"
  set newReminder to make new reminder at end of reminders of targetList
  set name of newReminder to "${safeTitle}"
  ${duePart}
  return "created"
end tell
`;
  try {
    await osascript(script);
    const due = dueDateStr ? ` (due: ${dueDateStr})` : "";
    return `Created reminder: "${title}"${due} in list "${listName}"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to create reminder: ${msg}`;
  }
}

// ── Weather ───────────────────────────────────────────────────────────────────

/**
 * Get current weather for a location using wttr.in (no API key needed).
 * Defaults to Kelowna, BC.
 */
export async function weatherGet(location = "Kelowna,BC"): Promise<string> {
  const encoded = encodeURIComponent(location);
  const url = `https://wttr.in/${encoded}?format=j1`;

  try {
    const { stdout } = await execAsync(`curl -s --max-time 8 "${url}"`, { timeout: 10_000 });
    const data = JSON.parse(stdout) as WttrResponse;
    const current = data.current_condition[0];
    const nearest = data.nearest_area[0];

    if (!current || !nearest) throw new Error("Unexpected API response structure");

    const areaName = nearest.areaName[0]?.value ?? location;
    const country = nearest.country[0]?.value ?? "";
    const temp = current.temp_C;
    const feelsLike = current.FeelsLikeC;
    const desc = current.weatherDesc[0]?.value ?? "";
    const humidity = current.humidity;
    const windSpeed = current.windspeedKmph;
    const windDir = current.winddir16Point;
    const visibility = current.visibility;

    // Today's forecast
    const today = data.weather[0];
    if (!today) throw new Error("No forecast data");
    const maxTemp = today.maxtempC;
    const minTemp = today.mintempC;
    const hourlyDescs = today.hourly
      .filter((h) => ["600", "900", "1200", "1500", "1800"].includes(h.time))
      .map((h) => `${String(Number(h.time) / 100).padStart(2, "0")}:00 ${h.weatherDesc[0]?.value ?? ""} ${h.tempC}°C`)
      .join(", ");

    return [
      `## Weather — ${areaName}, ${country}`,
      "",
      `**Now:** ${temp}°C (feels ${feelsLike}°C) — ${desc}`,
      `**Humidity:** ${humidity}% | **Wind:** ${windSpeed}km/h ${windDir} | **Visibility:** ${visibility}km`,
      `**Today:** High ${maxTemp}°C / Low ${minTemp}°C`,
      hourlyDescs ? `**Hourly:** ${hourlyDescs}` : "",
    ].filter(Boolean).join("\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Weather fetch failed for "${location}": ${msg}`;
  }
}

interface WttrResponse {
  current_condition: Array<{
    temp_C: string;
    FeelsLikeC: string;
    weatherDesc: Array<{ value: string }>;
    humidity: string;
    windspeedKmph: string;
    winddir16Point: string;
    visibility: string;
  }>;
  nearest_area: Array<{
    areaName: Array<{ value: string }>;
    country: Array<{ value: string }>;
  }>;
  weather: Array<{
    maxtempC: string;
    mintempC: string;
    hourly: Array<{
      time: string;
      tempC: string;
      weatherDesc: Array<{ value: string }>;
    }>;
  }>;
}
