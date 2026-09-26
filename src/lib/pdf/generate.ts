import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { PdfPayload } from "./payload";

const MARGIN = 54;

function pageWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return pageWidth(doc) - doc.page.margins.left - doc.page.margins.right;
}

function drawCover(doc: PDFKit.PDFDocument, payload: PdfPayload, jobId: string): void {
  const w = pageWidth(doc);
  const left = doc.page.margins.left;

  doc.fontSize(28).font("Helvetica-Bold").fillColor("#1a1a2e");
  doc.text(payload.reportTitle, left, 200, { width: contentWidth(doc), align: "center" });

  doc.fontSize(12).font("Helvetica").fillColor("#555555");
  doc.text("PDF Report", left, 268, { width: contentWidth(doc), align: "center" });

  doc
    .moveTo(left, 330)
    .lineTo(w - doc.page.margins.right, 330)
    .strokeColor("#aaaaaa")
    .lineWidth(1)
    .stroke();

  doc.moveDown(6);
  doc.fillColor("#222222");
  doc.fontSize(12).font("Helvetica");
  doc.text(`Job ID: ${jobId}`, left, 380, { width: contentWidth(doc) });
  doc.text(`Generated: ${new Date().toISOString()}`, left, 404, { width: contentWidth(doc) });
  doc.text("Status: completed", left, 428, { width: contentWidth(doc) });
}

function drawHeader(doc: PDFKit.PDFDocument, reportTitle: string): void {
  const left = doc.page.margins.left;
  doc.fontSize(9).font("Helvetica").fillColor("#666666");
  doc.text(reportTitle, left, doc.page.margins.top - 28, {
    width: contentWidth(doc),
    align: "right",
  });
}

function drawFooter(doc: PDFKit.PDFDocument, pageNumber: number, totalPages: number): void {
  const left = doc.page.margins.left;
  doc.fontSize(9).font("Helvetica").fillColor("#888888");
  doc.text(`Page ${pageNumber} of ${totalPages}`, left, doc.page.height - doc.page.margins.bottom + 12, {
    width: contentWidth(doc),
    align: "center",
  });
}

function drawTotalPages(doc: PDFKit.PDFDocument, totalPages: number): void {
  const left = doc.page.margins.left;
  doc.fontSize(12).font("Helvetica").fillColor("#222222");
  doc.text(`Total pages: ${totalPages}`, left, 496, { width: contentWidth(doc) });
}

export async function generatePdf(
  payload: PdfPayload,
  jobId: string,
  attempt = 1
): Promise<string> {
  if (payload._testFailure && attempt <= payload._testFailure.attemptsToFail) {
    throw new Error(
      `_testFailure: simulated failure on attempt ${attempt} of ${payload._testFailure.attemptsToFail}`
    );
  }

  const outputDir = path.resolve(config.PDF_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, `${jobId}.pdf`);
  const tmpPath = `${finalPath}.tmp`;

  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    bufferPages: true,
    info: { Title: payload.reportTitle },
  });
  const stream = fs.createWriteStream(tmpPath);
  doc.pipe(stream);

  drawCover(doc, payload, jobId);

  for (const section of payload.sections) {
    doc.addPage();
    const left = doc.page.margins.left;
    const width = contentWidth(doc);

    doc.fontSize(17).font("Helvetica-Bold").fillColor("#1a1a2e");
    doc.text(section.heading, left, doc.page.margins.top + 30, { width });
    doc.moveDown(0.6);

    doc.fontSize(11).font("Helvetica").fillColor("#222222");
    for (const paragraph of section.body) {
      doc.text(paragraph, { width, align: "justify", lineGap: 2 });
      doc.moveDown(0.5);
    }
  }

  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    drawFooter(doc, i + 1, totalPages);
    if (i > 0) drawHeader(doc, payload.reportTitle);
  }
  doc.switchToPage(0);
  drawTotalPages(doc, totalPages);

  await new Promise<void>((resolve, reject) => {
    stream.once("close", () => resolve());
    stream.once("error", (err) => reject(err));
    doc.end();
  });

  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}