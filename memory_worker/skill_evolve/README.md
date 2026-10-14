# memory_worker / skill_evolve

Online skill distillation engine (no SWE-bench evaluation). This is the default task-switch pipeline.

Entry: `run_skill_evolve_pipeline`, called from `memory_worker/server.py` `run_pipeline` when `MW_SKILL_PIPELINE=skill_evolve` (the default). Set `MW_SKILL_PIPELINE=legacy` to use analyzer + writer instead.

Flow: evidence → estimator gate → distiller → scorer → write.

See [INTEGRATION_REPORT.md](./INTEGRATION_REPORT.md).
