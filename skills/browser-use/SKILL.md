---
name: browser-use
description: Web browser automation skill for navigating pages, filling forms, clicking elements, taking screenshots, and extracting web data using AI-driven browser control.
---

# browser-use

Automate web browser interactions using AI-driven browser control.

## When to use

- The user needs to interact with a web page (fill forms, click buttons, navigate).
- Web scraping or data extraction from dynamic pages is required.
- Visual verification of web applications (screenshots, element inspection).
- Testing web UIs or checking deployment status.

## Instructions

1. **Tool selection**: Prefer the `browser-use` MCP server if available. Fallback to the built-in `web-browse` tool for simple page fetching.
2. **Navigation**: Use `browser-use open <url>` to navigate to pages. Wait for load completion.
3. **Interaction sequence**: Plan the interaction as a series of steps:
   - `open` → navigate to URL
   - `click` → click on element by selector or text
   - `type` → enter text into input fields
   - `screenshot` → capture current page state
   - `extract` → pull structured data from page
4. **Element identification**: Use CSS selectors, ARIA labels, or visible text to identify elements. Prefer semantic selectors over brittle XPath.
5. **Error handling**: If an element isn't found, take a screenshot to diagnose, then retry with an alternative selector.
6. **Data extraction**: Output extracted data as structured JSON or Markdown tables.
7. **Rate limiting**: Add reasonable delays between actions to avoid rate limiting or bot detection.
8. **Security**: Never enter real credentials. Use test/demo accounts only. Never screenshot sensitive information.
9. Reference: [browser-use/browser-use](https://github.com/browser-use/browser-use) — 88k+ stars, MIT license, Python + Chromium required.
