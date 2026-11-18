import { readFileSync } from "node:fs";

function readCgroupMemory() {
  if (process.platform !== "linux") return {};
  try {
    const root = "/sys/fs/cgroup";
    const stat = Object.fromEntries(
      readFileSync(`${root}/memory.stat`, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ")),
    );
    return {
      containerBytes: Number(readFileSync(`${root}/memory.current`, "utf8")),
      containerAnonBytes: Number(stat.anon),
      containerFileBytes: Number(stat.file),
    };
  } catch {
    return {};
  }
}

export function logServerMemory(stage: string, tabId?: number) {
  if (process.env.SCREENSHOT_MEMORY_LOGS !== "1") return;
  console.log(
    JSON.stringify({
      event: "screenshot-memory",
      stage,
      tabId,
      ...process.memoryUsage(),
      ...readCgroupMemory(),
    }),
  );
}
