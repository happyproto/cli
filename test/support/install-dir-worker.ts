// One of project-cache.test.ts's concurrent installers (cache.rs's scoped threads).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { installDir } from "../../src/project/cache.ts";

const { dir, times } = workerData as { dir: string; times: number };
for (let i = 0; i < times; i++) {
  installDir(dir, [
    ["a", Buffer.from("one")],
    ["b", Buffer.from("two")],
  ]);
  if (!(existsSync(join(dir, "a")) && existsSync(join(dir, "b"))))
    throw new Error("an install left a partial entry");
}
