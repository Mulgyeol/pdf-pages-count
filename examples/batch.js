#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { countPdfPages } = require("../src/index.js");

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isPdfFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".pdf";
}

async function listPdfFilesRecursively(dir) {
  const result = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await listPdfFilesRecursively(full);
      result.push(...sub);
    } else if (entry.isFile() && isPdfFile(full)) {
      result.push(full);
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dirArg = args[0];
  if (!dirArg) {
    console.error("Usage: node examples/batch.js <dir>");
    process.exit(1);
  }
  const expanded = expandTilde(dirArg);
  const dirPath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(process.cwd(), expanded);
  const stat = await fs.promises.stat(dirPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error(`Not a directory: ${dirPath}`);
    process.exit(1);
  }

  const files = await listPdfFilesRecursively(dirPath);
  if (files.length === 0) {
    console.log("No PDF files found.");
    return;
  }

  // Process sequentially to avoid heavy I/O bursts
  for (const file of files) {
    try {
      const pages = await countPdfPages(file);
      console.log(`${file}\t${pages}`);
    } catch (err) {
      console.log(`${file}\tERROR: ${err && err.message ? err.message : err}`);
    }
  }
}

main();
