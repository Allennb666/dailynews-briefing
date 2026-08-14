# Project Working Agreement

- Treat a completed major product update as ready for publication unless the user explicitly says to keep it local.
- Before publishing, run the relevant tests and production build, review the final diff, and exclude secrets, local environment files, dependencies, and build artifacts.
- Commit and push the completed in-scope update to `main` so the existing GitHub Pages workflow deploys it.
- After pushing, monitor both CI and Pages deployment, and report the live result or any blocker.
- Do not publish partial work, failed builds, or unrelated local changes as part of a major update.
