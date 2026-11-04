# 009 Codebase

This fork supports one internal Codebase repository through bytedcli, with Feishu for initial requests. Install the bundle and Feishu bot as in [006 Deployment](006-deployment.md). GitHub remains the default; enable Codebase explicitly. The adapter uses the public prototype's Source, Ticket, Thread and Outbox mechanisms without changing the Engine or database schema.

## Accounts and prerequisites

Use a dedicated agent account, a bytedcli configuration authenticated as that account, and an SSH key registered to the same account. Give it push access to one test repository. Setup reads the account and repository membership through bytedcli; it also runs `git ls-remote` using the explicit SSH key. Both must succeed. Do not paste credentials into settings or prompts: settings contain paths and account names only.

The CLI contract was checked against bytedcli 0.183.0. Run these on the deployment host, using the agent's configuration and the site/profile your team uses:

```sh
bytedcli --help
bytedcli --site cn --profile superagent auth --help
bytedcli --no-auto-upgrade --json --site cn --profile superagent codebase user get @me
bytedcli --no-auto-upgrade --json --site cn --profile superagent codebase repo get example/team-service
bytedcli --no-auto-upgrade --json --site cn --profile superagent codebase repo member get -R example/team-service
```

Replace every example path/account with your own. Authenticate using the CLI's documented flow before starting. An empty `profile` uses the CLI's default configuration; a dedicated profile or wrapper is recommended. `site` is required. The host may be `code.byted.org` or `code-tx.byted.org`.

SSH uses the configured key with `IdentitiesOnly=yes`, `BatchMode=yes`, `StrictHostKeyChecking=yes` and `-F /dev/null`. It does not read personal SSH config. Use an unencrypted key or make the same key available through the agent's SSH agent; no interactive passphrase prompt is possible. Verify and trust the code host's key through your organization's normal process first. No private-key contents are read by the application or copied into the database.

## Enable and configure

In the profile's `cordis.patch.yml`, add these alongside the main plugin and webserver settings:

```yaml
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-codebase
  disabled: false
- id: dsh-superagent-feishu
  disabled: false
```

Restart. In **Settings → Sources**, turn GitHub off and configure Codebase:

```json
{
  "enabled": true,
  "config": {
    "repository": "example/team-service",
    "cli": "/home/agent/.local/bin/bytedcli",
    "site": "cn",
    "profile": "superagent",
    "host": "code.byted.org",
    "sshKey": "/home/agent/.ssh/codebase_ed25519",
    "commitEmail": "agent@example.test",
    "pollSeconds": 60,
    "failuresBeforeError": 3,
    "botAccounts": [{"id": "review-bot"}]
  }
}
```

The same object can be saved to `PUT settings/source:codebase` using the current revision, as described in 006. Only one enabled, configured repository Source is allowed. A failed check returns `codebaseSetup` with the failing check; a successful account-field change restarts the plugin. Configure the bot-only Feishu CLI and one chat. Add allowed Feishu users and Codebase reviewers in **Policy**. Configure automated reviewers in `botAccounts`; their comments never count as human authorization.

In **Execution**, start with `maxWorkers: 1`. Create a local clone outside ticket directories, then use a prepare command such as:

```sh
git -C /home/agent/src/team-service fetch --no-tags "$DSH_SUPERAGENT_CODEBASE_CLONE_URL" "HEAD:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/agent/src/team-service worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

Workers receive the Codebase repository, login, commit email and SSH clone URL through `DSH_SUPERAGENT_CODEBASE_*`. `bytedcli` resolves through a shim that supplies the configured site/profile. The selected Source skill tells workers to discover MR create/update commands through CLI help, request human review and leave merging to people. GitHub-specific auto-merge and reviewer-credit commands do not apply to Codebase.

Existing prompt overrides are retained on upgrade. Review **Default updated** parts before use, especially worker, work, CLI and delivery instructions, so an old GitHub-only override does not direct a Codebase worker to gh.

## Example and acceptance

In the configured Feishu chat, an allowed user mentions the bot: “Fix the timeout error in the team-service retry test; keep the API unchanged, and create an MR after the test passes.”

1. The existing Feishu Source creates a Ticket and acknowledges in that topic. The worker creates its ticket branch, investigates, edits and runs the relevant checks.
2. The worker pushes and creates an MR through bytedcli, then calls `orchestrator_report` with `mr_number` and the actual URL in its summary. This association is required before Codebase polling starts. `pr_number` is reserved for GitHub; mixing fields is rejected.
3. The host verifies the MR's repository, agent author and ticket branch, then stores the stable thread key `codebase:<repository id>:<MR number>`. Another active Ticket cannot claim it. Comments on an adopted source MR may retain their original human author.
4. A review comment reaches the original worker; an unchanged comment is delivered once, while an edit with a new update timestamp becomes a new input. Self-comments are ignored. Bot comments do not authorize new work. Ready results return through the original Feishu conversation.
5. After a person merges or closes the MR, the Ticket ends according to the existing lifecycle and the original Feishu topic receives one merge/close notice. Failed replies remain in the existing Outbox retry flow; MR comments carry a stable hidden marker to avoid duplicate sends.

Before broadening access, exercise this loop in one test repository: duplicate polling, edited comments, review by an unlisted account, restart after MR binding, MR close/merge and Feishu in-topic reply. Confirm the saved Ticket/follows, Thread subscriptions and Outbox receipts in the panel. Unit and host integration tests use synthetic fixtures; they are not evidence of a successful deployment in your organization's Codebase or Feishu tenant.

## Current scope

The Source polls comments, review notes and open/closed/merged state only for MRs already associated with Tickets. It does not scan every new MR, automatically ingest CI results, or provide platform event streaming. Review replies are top-level MR comments; inline-thread resolution is not implemented. The worker can inspect build results through authorized CLI reads, but no CI watcher is installed.

This change supplies the Codebase connection. Service-specific log/APM diagnostics and production changes require separate tool configuration and explicit task authority. Start diagnostics with read-only access and a bounded service/time range. The dedicated OS-account recommendation in 006 still applies: CLI shims select credentials by default and do not isolate worker processes.
