-- Handset tracker on the site Overview: for each handset model the site's users and common area phones need, the project manager records
-- how far it has got (ordered, added to tooling and updated, installed and working). The quantities are not stored: they are counted from
-- discovery_users.handset_model and discovery_caps.device_model each time. A model with no row here is "Not ordered yet".
CREATE TABLE {{SCHEMA}}.site_handset_tracking (
  site_id        uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  model_key      text NOT NULL,           -- lower-cased, whitespace-collapsed model name: "Poly CCX 400" and "poly  ccx 400" are one model
  status         text NOT NULL CHECK (status IN ('ordered','in_tooling','installed')),
  updated_by     text,                    -- display name of the person who last changed it
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, model_key)
);
