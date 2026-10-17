/**
 * Read positioned text from a PDF in the browser. Imported lazily so the
 * PDF library only downloads when someone picks a PDF.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfTextItem } from './pdfText';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdfText(data: ArrayBuffer): Promise<PdfTextItem[]> {
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const it of content.items) {
        if (!('str' in it)) continue;
        items.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, page: n });
      }
    }
  } finally {
    await task.destroy();
  }
  return items;
}
