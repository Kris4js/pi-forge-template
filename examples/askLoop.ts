import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { MinipiAgentRuntime } from "../src/index.js";
import { isEndSignal, parseCliOptions, printCommonHelp } from "./cliUtils.js";

const options = parseCliOptions(process.argv.slice(2));

if (options.help) {
  printCommonHelp("chat:loop", "\nLoop commands:\n  /exit, /quit, /q, /end, exit, quit, q, :q, 结束, 退出\n\nExamples:\n  npm run chat:loop -- --workspace demo\n  printf '你好\\n退出\\n' | npm run chat:loop -- --no-stream\n");
  process.exit(0);
}

const runtime = new MinipiAgentRuntime({ workspace: options.workspace, userId: options.userId });
const rl = createInterface({
  input: stdin,
  output: stdout,
  terminal: Boolean(stdin.isTTY),
});

let sessionId = options.sessionId;
let closing = false;

async function shutdown(exitCode: number, reason: string) {
  if (closing) return;
  closing = true;
  console.log(`\n[${reason}] closing loop...`);
  rl.close();
  await runtime.dispose().catch(() => undefined);
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(130, "SIGINT"));
process.once("SIGTERM", () => void shutdown(143, "SIGTERM"));

console.log(`workspace=${options.workspace}`);
console.log(`userId=${options.userId}`);
console.log("输入问题开始对话；输入 /exit 或 退出 结束。Ctrl-C / SIGTERM 也会结束。\n");

if (stdin.isTTY) rl.setPrompt("你 > ");

try {
  if (options.prompt) {
    await chatOnce(options.prompt);
  }

  if (stdin.isTTY) rl.prompt();

  for await (const rawLine of rl) {
    if (closing) break;

    const prompt = rawLine.trim();
    if (isEndSignal(prompt)) {
      closing = true;
      break;
    }

    if (prompt) {
      await chatOnce(prompt);
    }

    if (stdin.isTTY) rl.prompt();
  }
} finally {
  await runtime.dispose();
}

console.log("loop closed");

async function chatOnce(prompt: string) {
  try {
    stdout.write("AI > ");
    const result = await runtime.chat(prompt, {
      userId: options.userId,
      sessionId,
      stream: options.stream,
    });
    sessionId = result.sessionId;

    if (!options.stream) {
      console.log(result.text);
    }

    console.log(`[sessionId=${result.sessionId}]`);
  } catch (error) {
    console.error(`\n[error] ${error instanceof Error ? error.message : String(error)}`);
  }
}
