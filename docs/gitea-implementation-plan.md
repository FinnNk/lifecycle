# Gitea PR lifecycle: implementation plan

Upstream baseline: `479a4a07476de474259580d8db59807770ca98da`.

Current branch status: the forge types, Gitea API adapter and webhook verification/mapping are implemented as a foundation. The Gitea webhook route, worker and build integration are not yet connected; configuring the variables below does not enable Gitea environments.

## Existing path

- `src/pages/api/webhooks/github.ts` verifies a GitHub signature, serialises the request and queues it. `GithubService.dispatchWebhook` verifies again and routes PR, push, label and comment events.
- `GithubService.handlePullRequestHook` finds an onboarded repository by GitHub installation and repository IDs, reads `lifecycle.yaml` at the PR head SHA for the initial decision, creates the PR and build, and queues reconciliation. Push events drive later updates.
- `RepositoryService`, `PullRequestService`, `server/lib/github` and `GlobalConfigService` supply GitHub App authentication, repository/PR lookup and YAML. `DeployableService` reads config again during reconciliation. `DeployService` selects source SHAs.
- `nativeBuild`, `nativeHelm` and Helm/Codefresh paths use GitHub clone URLs or credentials. `ActivityStream` writes GitHub PR comments. `TTLCleanupService` re-reads GitHub labels; `BuildService` already has a retrying deletion queue and guards queued work against a closed PR.

## Review batches

1. Introduce a small forge contract and Gitea adapter for authenticated repository/PR lookup, exact-SHA file content, clone access and idempotent status comments. Add raw-body signature verification and event mapping using Gitea's delivery and event-type headers. Keep the existing GitHub route and adapter behaviour.
2. Add provider identity columns and wire current-state Gitea PR reconciliation through the existing build/deploy/delete queues. Pin config and build to the current head SHA; prevent old deliveries and queued jobs from reviving closed or superseded PRs. Adapt config resolution, clone and status/TTL call sites through the forge boundary.
3. Add failure and GitHub regression tests, operating instructions and a local Gitea/Kubernetes demonstration. Record commands, observed results and remaining GitHub-specific paths. Open a PR for each completed batch and wait for acceptance before merging.

The first release should support one onboarded repository and its PR lifecycle. Cross-repository YAML dependencies, Codefresh and agent workspace tooling remain GitHub-specific until a separate experiment establishes their Gitea requirements. The lab's Argo CD topology is outside this fork's change.

## Adapter configuration reserved for the Gitea integration

These variables are read by the Gitea adapter, but the application does not yet start a Gitea webhook worker. Do not use this batch as an operating guide.

| Variable | Purpose |
| --- | --- |
| `GITEA_BASE_URL` | HTTPS URL of the instance, including any installation path. Its presence enables adapter configuration loading. |
| `GITEA_TOKEN` | Bot personal access token for API reads, Git over HTTPS and issue comments. |
| `GITEA_USERNAME` | Bot username for Git over HTTPS. |
| `GITEA_WEBHOOK_SECRET` | Current HMAC secret. |
| `GITEA_WEBHOOK_SECRET_PREVIOUS` | Optional previous secret during rotation. Remove it after deliveries signed with the old secret have drained. |
| `GITEA_CA_FILE` | Optional PEM file for the API client's trusted CA. The future build clone path must trust the same CA separately. |
| `GITEA_ALLOW_HTTP` | Set to `true` only for a loopback demonstration without TLS. |

The intended minimum Gitea token scopes are `read:repository` for PR and exact-commit content reads and `write:issue` for the status comment. The bot also needs read access to the code unit of every private repository it builds, including a PR's source fork. Repository webhook administration can be performed separately by an administrator; the runtime token does not need that permission. These scopes follow [Gitea's API token permissions](https://docs.gitea.com/1.26/development/api-usage/) and [repository units](https://docs.gitea.com/1.24/usage/permissions/).
