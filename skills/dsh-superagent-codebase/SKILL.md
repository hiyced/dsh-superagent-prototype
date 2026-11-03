---
name: dsh-superagent-codebase
description: Work on the configured Codebase repository through the agent bytedcli profile, follow MR reviews and deliver results to the originating conversation.
---

Use the configured `bytedcli` on the host for Codebase operations. It selects the deployment's site and auth profile.
Use `--json` before `codebase` and pass `-R "$DSH_SUPERAGENT_CODEBASE_REPOSITORY"` to repository and MR commands.
Read `--help` before using an unfamiliar command or option. A successful bytedcli response has `status: "success"`; read its `data` field. An authentication failure is a blocker, not an empty repository.
Read the repository's `AGENTS.md` and the original request before changing code.

For repository metadata use `bytedcli --json codebase repo get "$DSH_SUPERAGENT_CODEBASE_REPOSITORY"`.
For a merge request use `bytedcli --json codebase mr get <number> -R "$DSH_SUPERAGENT_CODEBASE_REPOSITORY"`.
Read feedback with `bytedcli --json codebase mr comment list <number> -R "$DSH_SUPERAGENT_CODEBASE_REPOSITORY"`.
Use the configured Git SSH identity. The default commit identity is `DSH_SUPERAGENT_CODEBASE_ACCOUNT` and `DSH_SUPERAGENT_CODEBASE_COMMIT_EMAIL`, unless Delivery requirements specifies another author.

For an authorized coding task, investigate, implement, run relevant checks and review the diff. Push the ticket branch and create an MR using the options confirmed by `bytedcli codebase mr create --help`.
Immediately call `orchestrator_report` with `state: progress`, `mr_number` and the actual MR URL. Use `mr_number` throughout this Codebase ticket; `pr_number` belongs to GitHub.
The host validates the MR's repository, author and branch before associating it. Report only a source MR or an MR created by this deployment's account on the ticket branch.
Once ready for a person to review, report `ready` with the actual checks and their outcomes. Follow human review comments and correct actionable problems. Keep the original Feishu request as the delivery destination.
People merge Codebase MRs. Do not enable auto-merge, approve for a reviewer, bypass a required check, deploy a service or modify production data under an ordinary coding assignment.

For explicitly requested diagnostics, use the team's available bytedcli skills and knowledge sources. Identify the service, site, region and time range before querying. Keep observed facts and hypotheses separate, cite evidence, and keep the report within the original task's scope.
Never copy internal source, logs, credentials or personal data to public services. Use the organization's approved model and execution environment.
