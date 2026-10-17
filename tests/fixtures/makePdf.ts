import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Text placed at (x, y) on a page; y counts down from the top for readability. */
export type PdfText = [x: number, yFromTop: number, text: string];

export async function makePdf(pages: PdfText[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const texts of pages) {
    const page = doc.addPage([612, 792]);
    for (const [x, y, text] of texts) page.drawText(text, { x, y: 792 - y, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

/** A typical ADP-style earnings statement with a commission line. */
export function paystub(payDate: string, commission: string, ytd: string): PdfText[] {
  return [
    [50, 50, 'Northstar Software, Inc.'],
    [400, 50, 'Earnings Statement'],
    [50, 80, 'Employee: Jordan Lee'],
    [400, 80, `Pay Date: ${payDate}`],
    [50, 95, 'Period Beginning: 01/01/2026'],
    [50, 130, 'Earnings'],
    [200, 130, 'Rate'],
    [260, 130, 'Hours'],
    [330, 130, 'Current'],
    [430, 130, 'YTD'],
    [50, 145, 'Regular'],
    [200, 145, '64.10'],
    [260, 145, '80.00'],
    [330, 145, '5,128.21'],
    [430, 145, '15,384.63'],
    [50, 160, 'Commission'],
    [330, 160, commission],
    [430, 160, ytd],
    [50, 190, 'Gross Pay'],
    [330, 190, '11,128.21'],
    [50, 205, 'Federal Income Tax'],
    [330, 205, '-1,820.00'],
    [50, 235, 'Net Pay'],
    [330, 235, '7,512.40'],
  ];
}
