"use strict";

// Runs automatically before `npm start` (npm's "prestart" lifecycle hook).
// Frees the app's port by stopping any stale node.exe process already
// listening on it, so `npm start` doesn't fail with EADDRINUSE.

const { execSync } = require("child_process");

const PORT = process.env.PORT || 3000;

if (process.platform !== "win32") process.exit(0);

function findListeningPids(port) {
  let output;
  try {
    output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && Number(match[1]) === Number(port)) pids.add(match[2]);
  }
  return [...pids];
}

function isNodeProcess(pid) {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
    return output.toLowerCase().includes("node.exe");
  } catch {
    return false;
  }
}

for (const pid of findListeningPids(PORT)) {
  if (pid === String(process.pid) || !isNodeProcess(pid)) continue;
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    console.log(`Freed port ${PORT}: stopped stale node process ${pid}.`);
  } catch {
    // Already exited between the check and the kill; nothing to do.
  }
}
