-- Which port document types are in use is now decided per site only ("Active for this site"). Different countries need different
-- documents, so the customer-wide Active switch on the catalog is gone.
--
-- A type that was switched off customer-wide stays off at every site that had it on; the catalog flag is then set back to true so it
-- never hides a type anywhere (the column is kept, nothing reads it any more).

UPDATE {{SCHEMA}}.site_port_document_types s
   SET enabled = false
  FROM {{SCHEMA}}.port_document_types dt
 WHERE dt.id = s.document_type_id
   AND dt.active = false;

UPDATE {{SCHEMA}}.port_document_types SET active = true WHERE active = false;
