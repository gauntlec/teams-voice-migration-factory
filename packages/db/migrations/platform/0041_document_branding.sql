-- Branding on generated documents (handover packs, change recordings, resource account requests, report PDFs, call flow
-- diagrams): for a customer looked after by an MSP, whether documents carry the MSP's branding or the customer's own. Set on
-- Administration > Customers. Without an MSP the customer's branding is used (Voxshift's when it has none) - see
-- packages/shared/src/document-branding.ts.
ALTER TABLE platform.tenants
  ADD COLUMN document_branding text NOT NULL DEFAULT 'msp' CHECK (document_branding IN ('msp', 'customer'));
