/**
 * macOS System Monitor — CPU, memory, disk, processes, network.
 * Uses only macOS built-ins: vm_stat, top, df, sysctl, ps, netstat.
 * No npm dependencies.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

async function run(cmd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, { timeout: 10_000 });
  return stdout.trim();
}

/**
 * Overall system status: CPU, memory, disk, uptime, load averages.
 */
export async function sysGetStatus(): Promise<string> {
  const [load, memRaw, vmStat, diskRaw, uptime] = await Promise.all([
    run("sysctl -n vm.loadavg").catch(() => "unknown"),
    run("sysctl -n hw.memsize").catch(() => "0"),
    run("vm_stat").catch(() => ""),
    run("df -H / 2>/dev/null | tail -1").catch(() => ""),
    run("uptime").catch(() => ""),
  ]);

  // Parse load average (format: { 1.23 0.45 0.67 })
  const loadMatch = load.match(/\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const load1 = loadMatch ? loadMatch[1] : "?";
  const load5 = loadMatch ? loadMatch[2] : "?";
  const load15 = loadMatch ? loadMatch[3] : "?";

  // Parse memory
  const totalMemGB = Math.round(Number(memRaw) / (1024 ** 3));
  let freeMemGB = "?";
  const pageMatch = vmStat.match(/Pages free:\s+(\d+)/);
  const speculativeMatch = vmStat.match(/Pages speculative:\s+(\d+)/);
  if (pageMatch) {
    const pageSize = 16384; // 16KB pages on Apple Silicon, 4KB on Intel
    const freePages = Number(pageMatch[1]) + (speculativeMatch ? Number(speculativeMatch[1]) : 0);
    freeMemGB = (freePages * pageSize / (1024 ** 3)).toFixed(1);
  }

  // Parse disk
  const diskParts = diskRaw.split(/\s+/);
  const diskSize = diskParts[1] ?? "?";
  const diskUsed = diskParts[2] ?? "?";
  const diskAvail = diskParts[3] ?? "?";
  const diskPct = diskParts[4] ?? "?";

  // Parse uptime cleanly
  const uptimeClean = uptime.replace(/.*up\s+/, "").replace(/,\s+\d+ users.*/, "").trim();

  return [
    "## System Status",
    "",
    `**CPU Load:** ${load1} (1m) / ${load5} (5m) / ${load15} (15m)`,
    `**Memory:** ${freeMemGB}GB free of ${totalMemGB}GB`,
    `**Disk (/):** ${diskUsed} used / ${diskAvail} free / ${diskSize} total (${diskPct})`,
    `**Uptime:** ${uptimeClean}`,
  ].join("\n");
}

/**
 * Top processes by CPU usage.
 */
export async function sysGetProcesses(limit = 10): Promise<string> {
  const raw = await run(`ps axo pid,pcpu,pmem,comm -r | head -${limit + 1}`).catch(() => "");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= 1) return "Could not retrieve process list.";

  const header = "PID       %CPU  %MEM  Process";
  const rows = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    const pid = parts[0] ?? "";
    const cpu = parts[1] ?? "";
    const mem = parts[2] ?? "";
    const comm = parts.slice(3).join(" ").split("/").pop() ?? parts.slice(3).join(" ");
    return `${pid.padEnd(9)} ${cpu.padStart(4)}  ${mem.padStart(4)}  ${comm}`;
  });

  return [`## Top ${limit} Processes by CPU`, "", header, ...rows].join("\n");
}

/**
 * Network status: active interfaces and connection count.
 */
export async function sysGetNetwork(): Promise<string> {
  const [ifconfig, connCount] = await Promise.all([
    run("ifconfig -l").catch(() => ""),
    run("netstat -an | grep ESTABLISHED | wc -l").catch(() => "0"),
  ]);

  // Get IP for en0 (primary WiFi/Ethernet)
  const en0ip = await run("ipconfig getifaddr en0").catch(() => "none");

  const interfaces = ifconfig.trim().split(/\s+/).filter((i) => !["lo0", "gif0", "stf0", "XHC20"].includes(i));
  const established = connCount.trim();

  return [
    "## Network",
    "",
    `**Primary IP (en0):** ${en0ip}`,
    `**Interfaces:** ${interfaces.join(", ")}`,
    `**Established connections:** ${established}`,
  ].join("\n");
}
