# Dependency updates

GitHub Dependabot proposes dependency and GitHub Actions updates. It does not
merge them or publish an application release.

- Routine version checks run Mondays at 09:00 UTC.
- npm minor/patch updates are grouped by provider SDKs, terminal runtime,
  development tools, and remaining packages. Groups use first-match order.
- GitHub Actions minor/patch updates share a group. Major upgrades stay separate
  so compatibility changes can be reviewed individually.
- Open version-update PRs are limited to four for npm and two for Actions.
  Those limits do not cap security-update PRs.
- Security updates have their own groups per ecosystem, without a version-level
  restriction. They are triggered by vulnerability alerts, independently of the
  weekly version schedule. Keep Dependabot alerts and security updates enabled
  in repository settings; the YAML alone does not enable those settings.
- Required checks and approving reviews apply to bot PRs. No automatic merge or
  branch-protection bypass is configured.

Review dependency release notes alongside CI results. The application is tested
with Node.js 24; a newer major of `@types/node` requires compatibility review of
the pinned upstream client, even if a newer Node runtime is available. Changes
to packaging actions need packaging validation: the fixture workflow alone does
not exercise uploading release artifacts.

Configuration: [dependabot.yml](../.github/dependabot.yml).
GitHub documents [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
