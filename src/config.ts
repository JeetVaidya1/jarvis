import { createLogger } from "./logger.js";

const log = createLogger("config");

interface ConfigGroup {
  name: string;
  keys: string[];
  required: boolean;
}

const CONFIG_GROUPS: ConfigGroup[] = [
  {
    name: "Core",
    keys: [
      "ANTHROPIC_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_ID",
    ],
    required: true,
  },
  {
    name: "Polymarket",
    keys: [
      "POLYMARKET_WALLET_PRIVATE_KEY",
      "POLYMARKET_PROXY_ADDRESS",
      "POLYMARKET_API_KEY",
      "POLYMARKET_API_SECRET",
      "POLYMARKET_API_PASSPHRASE",
    ],
    required: false,
  },
  {
    name: "GitHub",
    keys: ["GITHUB_TOKEN"],
    required: false,
  },
];

export interface ConfigStatus {
  valid: boolean;
  capabilities: string[];
  warnings: string[];
}

/**
 * Validate all configuration at startup.
 * Required groups throw on missing keys.
 * Optional groups log warnings for partial configuration.
 */
export function validateConfig(): ConfigStatus {
  const capabilities: string[] = [];
  const warnings: string[] = [];

  for (const group of CONFIG_GROUPS) {
    const present = group.keys.filter((k) => process.env[k]);
    const missing = group.keys.filter((k) => !process.env[k]);

    if (group.required) {
      if (missing.length > 0) {
        throw new Error(
          `Missing required env vars (${group.name}): ${missing.join(", ")}`,
        );
      }
      capabilities.push(group.name);
      continue;
    }

    // Optional group
    if (present.length === 0) {
      log.info(`${group.name}: not configured (all keys missing) — disabled`);
      continue;
    }

    if (missing.length > 0) {
      const msg = `${group.name}: partially configured — missing ${missing.join(", ")}. Some features may fail.`;
      log.warn(msg);
      warnings.push(msg);
    } else {
      capabilities.push(group.name);
      log.info(`${group.name}: fully configured`);
    }
  }

  // Validate specific formats
  const pk = process.env["POLYMARKET_WALLET_PRIVATE_KEY"];
  if (pk && !pk.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
    const msg = "POLYMARKET_WALLET_PRIVATE_KEY doesn't look like a valid private key (expected 64 hex chars)";
    log.warn(msg);
    warnings.push(msg);
  }

  const proxy = process.env["POLYMARKET_PROXY_ADDRESS"];
  if (proxy && !proxy.match(/^0x[0-9a-fA-F]{40}$/)) {
    const msg = "POLYMARKET_PROXY_ADDRESS doesn't look like a valid Ethereum address (expected 0x + 40 hex chars)";
    log.warn(msg);
    warnings.push(msg);
  }

  const ghToken = process.env["GITHUB_TOKEN"];
  if (ghToken && !ghToken.match(/^(ghp_|github_pat_|gho_|ghs_)/)) {
    const msg = "GITHUB_TOKEN doesn't match known GitHub token prefixes (ghp_, github_pat_, gho_, ghs_)";
    log.warn(msg);
    warnings.push(msg);
  }

  log.info(
    `Capabilities: ${capabilities.join(", ")}${warnings.length > 0 ? ` | ${warnings.length} warning(s)` : ""}`,
  );

  return { valid: true, capabilities, warnings };
}
