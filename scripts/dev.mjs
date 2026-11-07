import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const socketPath = resolve(".data/dev.sock");
const action = process.argv[2] ?? "start";

function request(command) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("Dev control connection timed out")));
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try {
        resolveRequest(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolveRequest(null);
      else reject(error);
    });
  });
}

if (action === "status" || action === "down") {
  const state = await request(action);
  if (!state) {
    console.log("Dev services are not running.");
  } else if (action === "status") {
    console.log(`Dev supervisor: ${state.stopping ? "stopping" : "running"} (PID ${state.pid})`);
    console.table(state.services);
  } else {
    let stopped = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      await delay(100);
      const current = await request("status");
      if (!current || current.pid !== state.pid) {
        stopped = true;
        break;
      }
    }
    if (!stopped) throw new Error("Dev services have not stopped within 8 seconds.");
    console.log("Dev services stopped.");
  }
  process.exit(0);
}

if (action !== "start") throw new Error(`Unknown dev command: ${action}`);

const children = [];
let stopping = false;
const server = createServer((socket) => {
  let input = "";
  socket.on("error", () => {});
  socket.setTimeout(2000, () => socket.destroy());
  socket.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const command = input.trim();
    socket.end(JSON.stringify({
      pid: process.pid,
      stopping,
      services: children.map((child) => ({
        service: child.service,
        pid: child.pid ?? null,
        status: child.pid && child.exitCode === null && child.signalCode === null ? "running" : "stopped",
      })),
    }));
    if (command === "down") stop(0);
  });
});

mkdirSync(resolve(".data"), { recursive: true });
const listen = () => new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => {
    server.removeListener("error", reject);
    resolveListen();
  });
});
try {
  await listen();
} catch (error) {
  if (error.code !== "EADDRINUSE") throw error;
  if (await request("status")) throw new Error("Dev services are already running. Use make status or make down.");
  rmSync(socketPath, { force: true });
  await listen();
}
server.unref();

function signalChildren(signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error);
    }
  }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  signalChildren("SIGTERM");
  setTimeout(() => signalChildren("SIGKILL"), 5000).unref();
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("exit", () => {
  signalChildren("SIGKILL");
  rmSync(socketPath, { force: true });
});

for (const [service, command, args] of [
  ["gateway + runtime", "./bin/gateway", []],
  ["web", "npm", ["run", "dev", "-w", "web"]],
]) {
  const child = spawn(command, args, { stdio: "inherit", detached: true });
  child.service = service;
  children.push(child);
  child.on("error", (error) => {
    console.error(`Failed to start ${command}:`, error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${command} exited (${signal ?? code}); stopping dev servers.`);
      stop(code ?? 1);
    }
  });
}
