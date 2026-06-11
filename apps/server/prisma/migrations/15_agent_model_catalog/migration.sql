-- Model-catalog persistence: the sidecar pushes each agent's model
-- catalog at supervisor spawn (and every on-demand fetch re-persists),
-- so GET /agents/:id/models serves from this row instead of waiting on
-- a live CLI exec — warm across server restarts and for every browser.
--
-- "modelCatalog" holds {source: 'static'|'cli', models: [...]} (see
-- ModelCatalogEntry in shared-types). "modelCatalogAt" is the probe
-- time and drives stale-while-revalidate: reads older than the
-- threshold are served as-is while a background refresh runs.
ALTER TABLE "Agent" ADD COLUMN "modelCatalog" JSONB;
ALTER TABLE "Agent" ADD COLUMN "modelCatalogAt" TIMESTAMP(3);
