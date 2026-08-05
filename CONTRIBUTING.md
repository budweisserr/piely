# Contributing

Contributions are welcome — bug reports, fixes, features, docs, and tests.

## AI-assisted code

AI-assisted contributions are welcome, with one condition: **you are responsible for the code you submit.**

- You understand what the AI-generated code does and why it exists.
- You have run it, exercised the changed paths, and fixed what broke.
- You can explain the change in the PR description (see below).

Unreviewed AI output submitted as-is will be rejected. "The AI wrote it" is not a substitute for verification.

## Issues

- Search for an existing issue before opening a new one.
- One issue = one problem. No compound reports.
- State: what you did, what you expected, what happened. Include the platform/version and any error output.
- A minimal repro or screenshot beats a paragraph of description.

## Pull requests

- Base your work on `develop`; keep the diff as small as the change allows.
- One PR = one logical change. Separate refactors from fixes.
- Follow the existing style of the code you touch — formatting, naming, patterns.
- Update docs (the [wiki](https://github.com/budweisserr/piely/wiki)) when the change affects behavior or setup.

### Every PR needs a description

Write a short description that answers:

1. **What** — what the PR changes.
2. **Why** — the problem it solves (link the issue if one exists).
3. **How tested** — what you ran and what you observed (e.g. `./build.sh dev`, which flows you exercised).

The title should summarize the change; the description explains it. A PR without a description will be sent back.

## Development

See the [wiki → Getting Started](https://github.com/budweisserr/piely/wiki/Getting-Started) for build instructions and setup.

## License

By contributing you agree that your work is licensed under GPL-3.0, matching the project.
