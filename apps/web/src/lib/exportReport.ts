import { reportFileName, reportSheets, toCsv, type ReportDocument } from '@tvmf/shared';
import { downloadText } from './download';

/** The report as an Excel workbook: a Summary sheet, then one sheet per table (reportSheets). */
export async function exportReportExcel(doc: ReportDocument, customer: string) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const sheet of reportSheets(doc, customer)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  XLSX.writeFile(wb, `${reportFileName(doc, customer)}.xlsx`);
}

/** The report's largest table as CSV, for loading into another system. */
export function exportReportCsv(doc: ReportDocument, customer: string) {
  const tables = reportSheets(doc, customer).slice(1);
  const biggest = tables.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!biggest) return;
  downloadText(`${reportFileName(doc, customer)}.csv`, toCsv(biggest.rows), { bom: true });
}

/** Whether a report has a table to export as CSV. */
export const hasTable = (doc: ReportDocument) => doc.sections.some((s) => s.kind === 'table');
