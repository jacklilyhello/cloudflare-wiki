import { spawn } from "node:child_process";

const preview = spawn(
  "node_modules/.bin/vite",
  ["preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  { stdio: "inherit" },
);
try {
  const smoke = spawn(process.execPath, ["scripts/smoke-test.mjs"], {
    stdio: "inherit",
  });
  const status = await new Promise((resolve, reject) => {
    smoke.on("exit", resolve);
    smoke.on("error", reject);
    preview.on("error", (error) => {
      smoke.kill("SIGTERM");
      reject(error);
    });
    preview.on("exit", (code) => {
      smoke.kill("SIGTERM");
      reject(new Error(`Preview exited before smoke completed: ${code}`));
    });
  });
  process.exitCode = status ?? 1;
} finally {
  preview.kill("SIGTERM");
}
