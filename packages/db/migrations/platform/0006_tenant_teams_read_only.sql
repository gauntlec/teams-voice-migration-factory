-- Per-customer safeguard: when set, the platform must never send a write
-- cmdlet (Set-Cs*/Grant-Cs*/New-Cs*/Remove-Cs*) to this customer's live
-- Microsoft Teams tenant, regardless of what deployment mode is requested.
-- Read activity (Discovery, live-vs-target validation) is unaffected - it
-- never goes through the write path this flag gates. Enforced in two
-- places: apps/api DeploymentService.createDeployment (fast 403 at
-- creation time) and apps/worker main.ts handleDeploymentRun (re-checked
-- fresh at run time, right before the one exec.invoke() call site in the
-- whole codebase - defense in depth, doesn't trust the queued job payload).

ALTER TABLE platform.tenants
  ADD COLUMN teams_read_only boolean NOT NULL DEFAULT false;
