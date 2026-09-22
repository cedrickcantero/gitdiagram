# GitDiagram

Turn any public or private GitHub repository into an interactive architecture diagram.

**[Try GitDiagram →](https://gitdiagram.com/)** · Or replace `hub` with `diagram` in any GitHub repository URL.

[![GitDiagram front page](./docs/readme_img.png)](https://gitdiagram.com/)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Explore the architecture** with an AI-generated diagram and streamed explanation.
- **Jump to the code** by clicking any component's linked file or directory.
- **Use private repositories** with a GitHub token via **Private Repos** in the header.
- **Diagram a local repository** from disk at `/local/<folder-name>` when running a development server.
- **Export diagrams** as PNG or copy the Mermaid source.

## Run locally

Requires [Bun](https://bun.sh/), Cloudflare R2, Upstash Redis, and an OpenAI or OpenRouter API key. See the [setup guide](docs/dev-setup.md) for prerequisites and configuration.

```bash
git clone https://github.com/cedrickcantero/gitdiagram.git
cd gitdiagram
bun install
cp .env.example .env
```

Fill in `.env` using the [configuration guide](docs/dev-setup.md#configure), then start the app:

```bash
bun run dev
```

Open [localhost:3000](http://localhost:3000).

### Local repositories

A development server can diagram a git repository on disk instead of one on GitHub. Set both `LOCAL_REPO_ROOT`, a directory containing git repositories, and `R2_ENDPOINT` in `.env`, then open `/local/<folder-name>`.

The repository is read at committed `HEAD`, so uncommitted work is not included. The mode is unavailable in production builds. `R2_ENDPOINT` is required because a local generation writes its diagram to whichever artifact bucket storage points at, so the mode refuses to run unless storage is aimed at a local S3. See the [setup guide](docs/dev-setup.md#configure) for details.

## Development

Built with Next.js, React, TypeScript, Tailwind CSS, and Mermaid. Deployed on Vercel.

- [Architecture](docs/architecture.md) — generation pipeline, storage, and API
- [Development guide](docs/dev-setup.md) — setup, checks, and deployment
- [Deployment recovery](docs/deployment-failover.md) — Railway/Docker fallback

Contributions are welcome. Open an issue or pull request with a focused description and [verification notes](docs/dev-setup.md#verify).

Inspired by [Romain Courtois](https://github.com/cyclotruc)'s [Gitingest](https://gitingest.com/).
