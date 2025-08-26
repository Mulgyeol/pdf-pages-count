import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cjs from "./index.js";

// Provide ESM re-exports for import users
export const countPdfPages = cjs.countPdfPages;
export const countPdfPagesSync = cjs.countPdfPagesSync;

// Optional: default export for convenience
export default {
  countPdfPages,
  countPdfPagesSync,
};
