import { readFileSync } from "fs";
import { join } from "path";

const envPath = join(process.env.HOME ?? "~", ".muavin", ".env");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {}
