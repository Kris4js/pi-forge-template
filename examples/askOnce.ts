import { PiAgentRuntime } from "../src/index.js";
import { parseCliOptions, printCommonHelp, resolveSinglePrompt } from "./cliUtils.js";

const options = parseCliOptions(process.argv.slice(2));

if (options.help) {
  printCommonHelp("chat:once", "\nExamples:\n  npm run chat:once -- \"你好，简单介绍一下你自己\"\n  echo \"总结这句话\" | npm run chat:once -- --workspace demo\n");
  process.exit(0);
}

const prompt = await resolveSinglePrompt(options.prompt);
if (!prompt) {
  console.error("No prompt provided. Pass prompt args, pipe stdin, or type one interactively.");
  process.exit(1);
}

const runtime = new PiAgentRuntime({ workspace: options.workspace, userId: options.userId });

try {
  const result = await runtime.chat({
    prompt,
    userId: options.userId,
    sessionId: options.sessionId,
    stream: options.stream,
  });

  if (!options.stream) {
    console.log(result.text);
  }

  console.log(`sessionId=${result.sessionId}`);
  console.log(`workspace=${result.workspace}`);
  console.log(`userId=${result.userId}`);
  if (result.retention) console.log(`retention=${JSON.stringify(result.retention)}`);
} finally {
  await runtime.dispose();
}
