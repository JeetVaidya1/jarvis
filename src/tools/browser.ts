import { chromium, type Browser, type Page } from "playwright";
import { readFile } from "node:fs/promises";

const SCREENSHOT_PATH = "/tmp/jarvis-screenshot.png";
const MAX_CONTENT_LENGTH = 8000;
const MAX_WAIT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensureBrowser(): Promise<Page> {
  if (page && !page.isClosed()) {
    return page;
  }

  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }

  browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
  });

  page = await context.newPage();
  return page;
}

export async function browserNavigate(url: string): Promise<string> {
  try {
    const p = await ensureBrowser();
    await p.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const title = await p.title();
    const currentUrl = p.url();
    return `Navigated to: ${currentUrl}\nTitle: ${title}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR navigating to ${url}: ${msg}`;
  }
}

export async function browserScreenshot(): Promise<{
  text: string;
  base64: string | null;
}> {
  try {
    const p = await ensureBrowser();
    await p.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    const buffer = await readFile(SCREENSHOT_PATH);
    const base64 = buffer.toString("base64");
    return {
      text: `Screenshot saved to ${SCREENSHOT_PATH} (${buffer.length} bytes)`,
      base64,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { text: `ERROR taking screenshot: ${msg}`, base64: null };
  }
}

export async function browserClick(target: string): Promise<string> {
  try {
    const p = await ensureBrowser();

    // Try CSS selector first
    try {
      const el = p.locator(target);
      if ((await el.count()) > 0) {
        await el.first().click({ timeout: 5000 });
        return `Clicked element matching selector: ${target}`;
      }
    } catch {
      // Not a valid CSS selector or not found — try natural language
    }

    // Try getByRole with name
    const byRole = p.getByRole("button", { name: target });
    if ((await byRole.count()) > 0) {
      await byRole.first().click({ timeout: 5000 });
      return `Clicked button: "${target}"`;
    }

    // Try getByRole link
    const byLink = p.getByRole("link", { name: target });
    if ((await byLink.count()) > 0) {
      await byLink.first().click({ timeout: 5000 });
      return `Clicked link: "${target}"`;
    }

    // Try getByText
    const byText = p.getByText(target, { exact: false });
    if ((await byText.count()) > 0) {
      await byText.first().click({ timeout: 5000 });
      return `Clicked element with text: "${target}"`;
    }

    return `ERROR: Could not find clickable element matching: "${target}"`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR clicking "${target}": ${msg}`;
  }
}

export async function browserType(
  target: string,
  text: string,
): Promise<string> {
  try {
    const p = await ensureBrowser();

    // Try CSS selector first
    try {
      const el = p.locator(target);
      if ((await el.count()) > 0) {
        await el.first().fill(text);
        return `Typed "${text}" into element matching: ${target}`;
      }
    } catch {
      // Try natural language
    }

    // Try getByPlaceholder
    const byPlaceholder = p.getByPlaceholder(target);
    if ((await byPlaceholder.count()) > 0) {
      await byPlaceholder.first().fill(text);
      return `Typed "${text}" into field with placeholder: "${target}"`;
    }

    // Try getByLabel
    const byLabel = p.getByLabel(target);
    if ((await byLabel.count()) > 0) {
      await byLabel.first().fill(text);
      return `Typed "${text}" into field labeled: "${target}"`;
    }

    // Try getByRole textbox
    const byRole = p.getByRole("textbox", { name: target });
    if ((await byRole.count()) > 0) {
      await byRole.first().fill(text);
      return `Typed "${text}" into textbox: "${target}"`;
    }

    return `ERROR: Could not find input field matching: "${target}"`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR typing into "${target}": ${msg}`;
  }
}

export async function browserGetContent(): Promise<string> {
  try {
    const p = await ensureBrowser();

    const content = await p.evaluate(() => {
      // Remove scripts, styles, nav, header, footer
      const clone = document.body.cloneNode(true) as HTMLElement;
      const removeSelectors = [
        "script",
        "style",
        "nav",
        "noscript",
        "svg",
        "iframe",
      ];
      for (const sel of removeSelectors) {
        for (const el of clone.querySelectorAll(sel)) {
          el.remove();
        }
      }
      return clone.innerText || clone.textContent || "";
    });

    const cleaned = content
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .join("\n");

    if (cleaned.length > MAX_CONTENT_LENGTH) {
      return cleaned.slice(0, MAX_CONTENT_LENGTH) + "\n...(truncated)";
    }

    return cleaned || "(no text content found)";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR getting page content: ${msg}`;
  }
}

export async function browserWait(ms: number): Promise<string> {
  const capped = Math.min(Math.max(0, ms), MAX_WAIT_MS);
  await new Promise((resolve) => setTimeout(resolve, capped));
  return `Waited ${capped}ms`;
}

export async function browserEvaluate(script: string): Promise<string> {
  try {
    const p = await ensureBrowser();
    const result = await p.evaluate(script);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR evaluating script: ${msg}`;
  }
}

export async function browserClose(): Promise<string> {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
    if (browser) {
      await browser.close();
    }
  } catch {
    // ignore cleanup errors
  } finally {
    page = null;
    browser = null;
  }
  return "Browser closed.";
}

export async function closeBrowser(): Promise<void> {
  await browserClose();
}
