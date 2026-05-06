---
name: page-scraping-tools
description: "Use when: extracting page information, scraping static HTML, comparing rendered page text, using Scrapling, using Skyvern, or deciding between lightweight scraping and browser automation."
---

# Page Scraping Tools

Installed tooling in the workspace Python environment:

- `scrapling` for lightweight page scraping and resilient HTML extraction.
- `skyvern` for heavier browser automation when installed and configured.

Decision rule:

1. Use `scrapling` first for static pages, docs, article extraction, and simple DOM queries.
2. Use Playwright/browser tools for WebUI validation that needs real rendering or screenshots.
3. Use `skyvern` only for workflow automation across interactive pages, logins, or multi-step browser tasks.
4. Run `privacy-filter` before sharing scraped content externally.

Python environment:

- `c:/Users/周浩/vscode-workspace/octocode/.venv/Scripts/python.exe`
