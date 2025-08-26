#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { countPdfPages, countPdfPagesSync } = require("../src/index.js");

function printUsage() {
  console.log(
    "Usage: node examples/cli.js <pdf-path> [--sync]" +
      "\n  --sync: use sync API (default is async)"
  );
}

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const syncMode = args.includes("--sync");
  const positional = args.filter((a) => !a.startsWith("-"));
  const fileArgJoined = positional.join(" ").trim();
  if (!fileArgJoined) {
    console.error("Error: missing <pdf-path>");
    printUsage();
    process.exit(1);
  }

  const expanded = expandTilde(fileArgJoined);
  const pdfPath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(process.cwd(), expanded);
  if (!fs.existsSync(pdfPath)) {
    console.error(`Error: file not found: ${pdfPath}`);
    process.exit(1);
  }

  try {
    if (syncMode) {
      const pages = countPdfPagesSync(pdfPath);
      console.log(pages);
    } else {
      const pages = await countPdfPages(pdfPath);
      console.log(pages);
    }
  } catch (err) {
    console.error(
      "Failed to count pages:",
      err && err.message ? err.message : err
    );
    process.exit(2);
  }
}

main();
