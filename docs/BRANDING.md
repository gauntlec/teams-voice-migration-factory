# Branding on generated documents

Version 1.0, 5 November 2026

Every document Voxshift generates for a customer carries one brand: a name, a colour and (if one was uploaded) a logo.
This page says whose brand that is, where it is chosen, and which documents use it.

## Whose brand a document carries

| The customer | Documents carry |
|---|---|
| Has no MSP, or the platform's MSP feature is switched off | The customer's own branding |
| Is looked after by an MSP, set to **The MSP's branding** (the default) | The MSP's branding |
| Is looked after by an MSP, set to **The customer's branding** | The customer's own branding |

If the chosen side has no branding (no accent colour and no logo), the document uses Voxshift's own look, as before.

The name on a document is the MSP's name or the customer's name. The colour is the accent colour from the branding;
headings, table headers and callouts are built from it (the same colour ramp the app uses). The logo is the PNG or
JPEG uploaded on the branding page.

## Where it is set

**Administration > Customers**, under the customer's **MSP**: **Document branding** - *The MSP's branding* or
*The customer's branding*. The choice shows once an MSP is set; underneath it the screen says whose branding
documents carry right now (including when that falls back to Voxshift). Changing it is
recorded in the audit log as `tenant.document_branding_changed`.

Stored as `platform.tenants.document_branding` (`msp` or `customer`, default `msp`; migration platform 0041).

## The documents

All of these ask `DocumentBrandingService.forDocuments(tenantId)` (apps/api/src/modules/branding) for the brand,
so they always agree:

| Document | Made by | Format |
|---|---|---|
| Service handover pack | `HandoverDocumentService` | Word |
| Change recording (the change control for a deployment or dry run) | `DeploymentDocumentService.build` | Word |
| Resource account request | `DeploymentDocumentService.buildResourceAccountRequest` | Word |
| Reports, downloaded or attached to scheduled report emails | `renderReportPdf` (insights) | PDF |
| Call flow diagram export | `CallFlowDiagram` export (web app, reads `GET /api/t/:tenantId/document-branding`) | PDF |

Word documents: cover (logo, or the name), header and footer (`<name> · <document>` and the page number), and the
palette throughout (`apps/api/src/modules/branding/docx-brand.ts`).

## Deliberately not branded

- Excel and CSV exports (report data, licence report, validation issues) and import templates: they are data for
  people to work in, not documents to hand over.
- The portfolio report (Insights > All customers): it covers every customer, so it carries Voxshift's branding.
- Emails: they are already branded by who receives them (the existing email branding).

A new document generator must take its brand from `DocumentBrandingService` and be added to the table above and to
`tests/db/src/platform/document-branding.db.test.ts`.
