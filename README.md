## pdf-pages-count

Fast, dependency-free page count extractor for PDF files in Node.js.

### Install

```bash
npm i pdf-pages-count
```

### Usage

CommonJS:

```js
const { countPdfPages, countPdfPagesSync } = require("pdf-pages-count");

(async () => {
  const pages = await countPdfPages("/path/to/file.pdf");
  console.log(pages);
})();

const fs = require("fs");
const buf = fs.readFileSync("/path/to/file.pdf");
const pages2 = countPdfPagesSync(buf);
console.log(pages2);
```

ESM / TypeScript:

```ts
import { countPdfPages, countPdfPagesSync } from "pdf-pages-count";

const pages = await countPdfPages("/path/to/file.pdf");
const pages2 = countPdfPagesSync(new Uint8Array(/* ... */));
```

### How it works

- Tries classic xref parsing to read `/Root -> /Pages -> /Count`.
- Falls back to scanning for `/Type /Pages` and nearby `/Count N`.
- Additionally scans deflated streams (e.g., object streams) for those markers.
- As a last resort, counts occurrences of `/Type /Page` across plain and deflated content.

### Limitations

- Encrypted PDFs are not supported.
- Some exotic PDFs may still evade detection. Open an issue with a sample if that happens.

### License

MIT
