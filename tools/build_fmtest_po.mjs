#!/usr/bin/env node
// Build the FMTEST floppy with Cadius-managed ProDOS metadata.
// AI-assisted implementation, 2026-10-27.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileApplesoftBasic } from "../../veratest/src/applebasic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const cadius = process.env.CADIUS || path.join(root, "tools", "cadius.exe");
const baseline = path.resolve(root, "../veratest/assets/ProDOS 2.4.3.po");
const run = (...args) => execFileSync(cadius, args, { encoding: "utf8" });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fmtest-build-"));
const image = path.join(temp, "FMTEST.po");
const stage = path.join(temp, "stage");
fs.mkdirSync(stage);
try {
  fs.copyFileSync(baseline, image);
  run("RENAMEVOLUME", image, "FMTEST");
  // Find baseline entries before asking Cadius to remove them; preserve boot files.
  const disk = fs.readFileSync(image);
  const entries = [];
  for (let block = 2; block;) {
    const page = disk.subarray(block * 512, (block + 1) * 512);
    for (let i = block === 2 ? 1 : 0; i < 13; i++) {
      const off = 4 + i * 39, kind = page[off] >> 4, length = page[off] & 15;
      if (!kind || !length) continue;
      const name = page.toString("ascii", off + 1, off + 1 + length);
      if (name !== "PRODOS" && name !== "BASIC.SYSTEM") entries.push({ name, dir: kind === 13 });
    }
    block = page[2] | (page[3] << 8);
  }
  for (const entry of entries)
    run(entry.dir ? "DELETEFOLDER" : "DELETEFILE", image, `/FMTEST/${entry.name}`);
  const files = [
    ["FMTEST.BIN#062000", fs.readFileSync(path.join(src, "FMTEST.BIN"))],
    ["FMTEST4.BIN#062000", fs.readFileSync(path.join(src, "FMTEST4.BIN"))],
    ["STARTUP#FC0801", compileApplesoftBasic(src, "fmtest_startup.bas")],
  ];
  for (const [name, data] of files) {
    const file = path.join(stage, name);
    fs.writeFileSync(file, data);
    run("ADDFILE", image, "/FMTEST/", file);
  }
  const check = run("CHECKVOLUME", image);
  if (/declared|error\s*:/i.test(check)) throw new Error(`Volume check failed:\n${check}`);
  const catalog = run("CATALOG", image);
  for (const name of ["FMTEST.BIN", "FMTEST4.BIN", "STARTUP"])
    if (!catalog.includes(name)) throw new Error(`Catalog missing ${name}`);
  fs.copyFileSync(image, path.join(root, "FMTEST.po"));
  console.log("[OK] FMTEST.po: both slot binaries, STARTUP, clean Cadius volume");
} finally {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!path.resolve(temp).startsWith(tempRoot)) throw new Error("Unsafe temporary path");
  fs.rmSync(temp, { recursive: true, force: true });
}
