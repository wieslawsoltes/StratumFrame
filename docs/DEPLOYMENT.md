# Deployment

Production: https://wieslawsoltes.github.io/StratumFrame/

The GitHub Actions workflow `.github/workflows/pages.yml` runs all Node tests, numerical verification and the standalone build before staging `_site/`. Only static app assets, documentation, example inputs and executable browser benchmarks are published. The development server and Git metadata are not deployed.

Repository Pages must use **GitHub Actions** as its publishing source. The repository had Pages enabled before the first source import. No personal access token or repository secret is required for subsequent builds: build jobs have `contents: read`, and deployment has `pages: write` and `id-token: write`.

The final job opens the live project URL in Chromium and checks that the app loads with an actual Web Worker, solves the six-story model with 234 active DOFs, produces six modes, and reproduces its first frequency within 1e-9 Hz. It checks both the modular entry point and the portable HTML. This is not a GPU performance benchmark.
