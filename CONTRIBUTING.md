# Contributing to Octocode

Thank you for your interest in Octocode. This file describes the
minimum process expected for code, documentation, and translation
contributions.

## Repository

The canonical repository is
<https://github.com/sievepub-2000/octocode>. The default branch is
`master`. The release branch convention is `release/<version>` if a
backport is needed. All discussion happens publicly on the issue
tracker, the Discussions tab, and pull-request review threads.

## License

Octocode is licensed under the Apache License, Version 2.0
(`LICENSE` at the repository root). By submitting a contribution you
agree that the contribution is licensed under the same terms.

## Working language

The project's working language is **English**. Issue titles, commit
messages, code comments, and PR descriptions should be written in
English. User-facing UI strings live in the four
in-product locales (`en-US`, `ja-JP`, `ko-KR`, `zh-CN`); when adding
or changing UI strings, update all four locale files.

End-user reference documentation (`docs/modules/`) is maintained in
**English** and **Japanese**. Translations into other languages are
welcome but are not required for a release.

## How to contribute

1. Open an issue to describe the bug or proposed change before writing
   substantial code, unless the change is small and obviously correct.
2. Fork the repository and create a topic branch off `master`.
3. Run `cargo check --workspace` and the focused validation listed in
   `CLAUDE.md` for the layer you touched (runtime, providers,
   sessions, or Windows platform).
4. Submit a pull request. Reference the issue number, and describe the
   user-visible change in one or two sentences.

## Code style

- Rust: rustfmt defaults; one boundary per refactor commit; do not
  leave the workspace failing to compile.
- JavaScript (`ui-shell/`): vanilla ES, no build step. Match the
  existing brace and indentation style.
- Markdown: hard-wrap at 80 columns where possible.

## Commit messages

The repository follows [Conventional Commits](https://www.conventionalcommits.org/).
`CHANGELOG.md` is generated from history via `git cliff` (see
`cliff.toml`). Use one of the following prefixes so the changelog
groups your change correctly:

- `feat:` — new user-visible capability
- `fix:` — bug fix
- `perf:` — measurable performance improvement
- `refactor:` — internal restructuring with no behavior change
- `docs:` — documentation only
- `test:` — tests only
- `chore:` / `ci:` / `build:` — tooling, CI, or build system

Optional scope: `feat(cli): ...`, `fix(runtime): ...`. Keep the subject
in the imperative mood and under 72 characters.

## Validation gates

The following must pass locally before a PR is merged:

- `cargo check --workspace`
- A focused CLI smoke test for the touched slice (for example
  `octocode-cli doctor`, `octocode-cli ask --session main`, or a
  WebUI `/api/chat` round-trip on Windows).
- For provider routing changes, verify provider list rendering and
  health status via the Manage panel.
- For session or permission changes, verify session create/resume and
  read-only versus workspace-write denial.

## Filing issues

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Include the
output of `octocode-cli doctor`, the platform, and the provider id
plus base URL when reporting provider problems.

## Discussions and forum

The repository's GitHub Discussions tab is open for design
brainstorming, runtime questions, provider compatibility reports, and
release planning. Comments and replies on issues, discussions, and
pull requests are open to anyone with a GitHub account.

## Contact

For private or security-related concerns that should not be filed
publicly, see `SECURITY.md` and the contact addresses in the WebUI
(Help → Contact Us): `sievepub@outlook.com`.
