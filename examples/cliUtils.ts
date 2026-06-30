import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type CliOptions = {
  workspace: string;
  userId: string;
  sessionId?: string;
  stream: boolean;
  prompt?: string;
  help: boolean;
};

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    workspace: "demo",
    userId: "anonymous",
    stream: true,
    help: false,
  };
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      promptParts.push(...argv.slice(i + 1));
      break;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--workspace" || arg === "-w") {
      options.workspace = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      options.workspace = arg.slice("--workspace=".length) || options.workspace;
      continue;
    }

    if (arg === "--user-id" || arg === "-u") {
      options.userId = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--user-id=")) {
      options.userId = arg.slice("--user-id=".length) || options.userId;
      continue;
    }

    if (arg === "--session-id" || arg === "-s") {
      options.sessionId = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      options.sessionId = arg.slice("--session-id=".length) || undefined;
      continue;
    }

    if (arg === "--stream") {
      options.stream = true;
      continue;
    }

    if (arg === "--no-stream") {
      options.stream = false;
      continue;
    }

    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (prompt) options.prompt = prompt;
  options.workspace = normalizeWorkspace(options.workspace);
  options.userId = normalizeUserId(options.userId);

  return options;
}

export function isEndSignal(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return ["/exit", "/quit", "/q", "/end", "exit", "quit", "q", ":q", "结束", "退出"].includes(normalized);
}

export async function resolveSinglePrompt(cliPrompt?: string): Promise<string> {
  if (cliPrompt?.trim()) return cliPrompt.trim();

  if (!stdin.isTTY) {
    return await readStdinAll();
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question("请输入问题: ")).trim();
  } finally {
    rl.close();
  }
}

export function printCommonHelp(command: string, extra = "") {
  console.log(`Usage:\n  npm run ${command} -- [options] [prompt]\n\nOptions:\n  -w, --workspace <name>    Workspace name, default: demo\n  -u, --user-id <id>        User identity, default: anonymous\n  -s, --session-id <id>     Continue an existing session\n      --stream              Stream assistant output, default\n      --no-stream           Print final answer only\n  -h, --help                Show help\n${extra}`);
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function normalizeWorkspace(workspace: string): string {
  return workspace.trim().toLowerCase() || "demo";
}

function normalizeUserId(userId: string): string {
  return userId.trim() || "anonymous";
}

async function readStdinAll(): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return text.trim();
}
