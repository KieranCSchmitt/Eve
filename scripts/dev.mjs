import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";
import { buildHost } from "./build.mjs";

await buildHost();
const server = await createServer();
await server.listen();
const env = { ...process.env, EVE_DEV_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", "--app"], { stdio: "inherit", env });
const finish = async () => {
  child.kill();
  await server.close();
};
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
