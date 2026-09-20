import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import electron from "electron";

if (!process.stdin.isTTY)
  throw new Error(
    "Run provider setup in an interactive terminal. Keys are entered privately and never placed in command arguments.",
  );
const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});
let configuration;
try {
  const providerChoice = (
    await readline.question("Provider (openai or local): ")
  ).trim();
  if (!["openai", "local", "nemotron"].includes(providerChoice))
    throw new Error("Choose openai or local.");
  const kind = providerChoice === "local" ? "nemotron" : providerChoice;
  const model = (await readline.question("Exact model/checkpoint ID: ")).trim();
  if (!model) throw new Error("An explicit model ID is required.");
  if (kind === "openai") {
    configuration = {
      storage: "secure",
      provider: {
        id: "openai-runtime",
        kind,
        protocol: "openai-responses",
        model,
        enabled: true,
        roles: ["explain", "code", "prepare"],
      },
    };
  } else {
    const endpoint = (
      await readline.question("Observed complete loopback API endpoint: ")
    ).trim();
    const protocol = (
      await readline.question(
        "Qualified protocol (openai-responses or openai-chat-completions): ",
      )
    ).trim();
    let reasoningEffort;
    if (protocol === "openai-chat-completions") {
      const effort = (
        await readline.question(
          "Reasoning effort qualified for this runtime/model (none, low, medium, high, max; blank keeps runtime default): ",
        )
      ).trim();
      if (effort && !["none", "low", "medium", "high", "max"].includes(effort))
        throw new Error("Choose a qualified reasoning effort or leave it blank.");
      reasoningEffort = effort || undefined;
    }
    const outputMode = (
      await readline.question(
        "Qualified output mode (json-schema or json-object): ",
      )
    ).trim();
    const maxOutputTokens = Number((await readline.question("Qualified maximum output tokens (128–16384): ")).trim());
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 16384)
      throw new Error("Enter the output-token budget used in qualification.");
    const authentication = (
      await readline.question("Authentication (none or bearer): ")
    ).trim();
    const idle = (
      await readline.question(
        "Have you verified this runtime AND every previously used Eve local endpoint are idle or safely restarted? (yes/no): ",
      )
    ).trim();
    if (idle !== "yes")
      throw new Error(
        "Qualify and check the local runtime before enabling it.",
      );
    const roles = (
      await readline.question(
        "Qualified roles (comma separated: route, explain, prepare, code): ",
      )
    )
      .split(",")
      .map((role) => role.trim());
    if (
      !roles.length ||
      roles.some(
        (role) => !["route", "explain", "prepare", "code"].includes(role),
      )
    )
      throw new Error("Choose the roles that passed model qualification.");
    configuration = {
      storage: "secure",
      confirmedLocalIdle: true,
      provider: {
        id: "nemotron-local",
        kind,
        endpoint,
        protocol,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        outputMode,
        maxOutputTokens,
        authentication,
        cancellationMode: "unverified",
        model,
        enabled: true,
        roles,
      },
    };
  }
} finally {
  readline.close();
}

async function readSecret() {
  process.stdout.write("API key (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", receive);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const receive = (data) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value ? undefined : new Error("No key entered."));
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character.charCodeAt(0) >= 32) value += character;
        if (value.length > 4096) {
          finish(new Error("The key exceeds its size limit."));
          return;
        }
      }
    };
    process.stdin.on("data", receive);
  });
}
if (
  configuration.provider.kind === "openai" ||
  configuration.provider.authentication === "bearer"
)
  configuration.credential = await readSecret();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      key !== "ELECTRON_RUN_AS_NODE" &&
      !/(?:API_KEY|SECRET|TOKEN|PASSWORD)/i.test(key),
  ),
);
const child = spawn(electron, [".", "--configure-provider"], {
  env,
  stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.on("error", () => {});
child.stdin.end(JSON.stringify(configuration));
configuration.credential = undefined;
child.on("error", () => {
  console.error("Could not start Eve provider setup.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
