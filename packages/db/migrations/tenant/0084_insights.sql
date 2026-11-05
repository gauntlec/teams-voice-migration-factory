-- Voxshift Insights, step 1 (docs/INSIGHTS.md).
--
-- A site's target go-live date, set by a project manager or engineer. first_go_live keeps the date first agreed so a moved
-- date can be shown ("was 12 Nov"); it is set the first time a date is given and cleared only when the date is cleared.
-- Setting the date is a project decision, not Site Data: it does not touch the site's review or its recorded changes.
ALTER TABLE {{SCHEMA}}.discovery_sites
  ADD COLUMN target_go_live     date,
  ADD COLUMN first_go_live      date,
  ADD COLUMN go_live_changed_at timestamptz,
  ADD COLUMN go_live_changed_by uuid;

-- The customer's figures once a day (InsightsSnapshotService), so the Overview and Reports can show trends. One row per UTC
-- day; data is a MetricSnapshot (packages/shared/src/insights.ts). Rows older than two years are removed.
CREATE TABLE {{SCHEMA}}.metric_snapshots (
  day        date PRIMARY KEY,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
