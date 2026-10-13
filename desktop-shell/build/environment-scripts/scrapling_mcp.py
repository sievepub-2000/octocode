"""Scrapling as a stdio MCP server, built on the bundled fastmcp.

Scrapling's own `scrapling-mcp` needs mcp>=2, which would break fastmcp (and
with it code-review-graph) in the shared bundled Python. This exposes the same
fetchers through fastmcp instead.
"""
from __future__ import annotations

import base64
import shutil
from time import monotonic
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse

from fastmcp import FastMCP
from scrapling.core.shell import Convertor
from scrapling.fetchers import Fetcher

mcp = FastMCP("scrapling")

_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def _chrome() -> str | None:
    for candidate in _CHROME_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    return shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("msedge")


def _content(page, extraction_type: str, css_selector: str | None, main_content_only: bool) -> dict:
    chunks = list(
        Convertor._extract_content(
            page, css_selector=css_selector, extraction_type=extraction_type, main_content_only=main_content_only
        )
    )
    return {"status": page.status, "url": str(page.url), "content": "\n".join(chunks)}


# Keyless engines, tried in order until one returns results. Datacenter and
# proxy exits often get CAPTCHA pages from DuckDuckGo and Mojeek, so the engines
# that tolerate them come first. (name, url, row, link, title, snippet)
_ENGINES = [
    ("bing", "https://www.bing.com/search?q={q}&setlang=en", "li.b_algo", "h2 a", "h2 a", ".b_caption p"),
    ("brave", "https://search.brave.com/search?q={q}", 'div.snippet[data-type="web"]', "a", ".title", ".generic-snippet"),
    ("duckduckgo", "https://html.duckduckgo.com/html/?q={q}", "div.result", "a.result__a", "a.result__a", ".result__snippet"),
    ("mojeek", "https://www.mojeek.com/search?q={q}", "ul.results-standard li", "a.title", "a.title", "p.s"),
]


def _text(node) -> str:
    return " ".join(str(node.get_all_text(separator=" ")).split()) if node is not None else ""


def _real_url(href: str) -> str:
    """Unwrap the engines' click-tracking redirects to the result's own URL."""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        return parse_qs(parsed.query).get("uddg", [href])[0]
    if parsed.netloc.endswith("bing.com") and parsed.path.startswith("/ck/"):
        target = parse_qs(parsed.query).get("u", [""])[0]
        if target.startswith("a1"):
            encoded = target[2:]
            try:
                return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
            except ValueError:
                pass
    return href


def _search_engine(engine: tuple, query: str, limit: int, timeout: float) -> tuple:
    _, template, row_css, link_css, title_css, snippet_css = engine
    page = Fetcher.get(template.format(q=quote_plus(query)), impersonate="chrome", stealthy_headers=True, timeout=timeout)
    results = []
    for row in page.css(row_css):
        link = row.css(link_css).first
        href = link.attrib.get("href", "") if link is not None else ""
        if not href or (href.startswith("/") and not href.startswith("//")):
            continue
        url = _real_url(href)
        if "duckduckgo.com/y.js" in url or "bing.com/aclick" in url:
            continue  # ads
        title = _text(row.css(title_css).first) or _text(link)
        results.append({"title": title, "url": url, "snippet": _text(row.css(snippet_css).first)})
        if len(results) >= limit:
            break
    return page.status, results


@mcp.tool
def search(query: str, limit: int = 8, engine: str = "auto", timeout: int = 20) -> dict:
    """Search the web without an API key and return structured results (title, url, snippet).
    `engine` is "auto" (Bing, Brave, DuckDuckGo, Mojeek, until one answers) or one of those
    names. `timeout` is the total network budget across all engines, in seconds.
    Follow up with `get` on the most relevant URLs."""
    engines = [e for e in _ENGINES if engine in ("auto", e[0])]
    if not engines:
        raise ValueError(f"Unknown engine {engine!r}; use auto, bing, brave, duckduckgo or mojeek.")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    deadline = monotonic() + timeout
    failures = []
    for index, candidate in enumerate(engines):
        remaining = deadline - monotonic()
        if remaining <= 0:
            failures.append("Search timeout budget exhausted")
            break
        # Give later engines a chance without multiplying the total budget.
        attempt_timeout = remaining / (len(engines) - index)
        try:
            status, results = _search_engine(candidate, query, max(1, min(limit, 20)), attempt_timeout)
        except Exception as error:  # noqa: BLE001 - fall through to the next engine
            failures.append(f"{candidate[0]}: {error}")
            continue
        if results:
            return {"engine": candidate[0], "query": query, "results": results, "failed": failures}
        failures.append(f"{candidate[0]}: HTTP {status}, no results")
    return {"engine": None, "query": query, "results": [], "failed": failures}


@mcp.tool
def get(
    url: str,
    extraction_type: str = "markdown",
    css_selector: str | None = None,
    main_content_only: bool = True,
    timeout: int = 30,
) -> dict:
    """Fetch a URL with a real browser TLS/HTTP fingerprint (works on many sites that refuse
    plain HTTP clients) and return its content as "markdown" (default), "html" or "text".
    `css_selector` narrows the result to matching elements."""
    page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=timeout, follow_redirects="safe")
    return _content(page, extraction_type, css_selector, main_content_only)


@mcp.tool
def bulk_get(
    urls: list[str],
    extraction_type: str = "markdown",
    css_selector: str | None = None,
    main_content_only: bool = True,
    timeout: int = 30,
) -> list[dict]:
    """Like `get`, for several URLs; one result per URL, failures reported inline."""
    results = []
    for url in urls:
        try:
            results.append(get(url, extraction_type, css_selector, main_content_only, timeout))
        except Exception as error:  # noqa: BLE001 - report per URL, keep the batch
            results.append({"status": None, "url": url, "error": str(error)})
    return results


@mcp.tool
def fetch(
    url: str,
    extraction_type: str = "markdown",
    css_selector: str | None = None,
    main_content_only: bool = True,
    wait_selector: str | None = None,
    timeout_ms: int = 60000,
) -> dict:
    """Render a JavaScript-heavy page in the locally installed Chrome/Edge (headless) and
    return its content. Slower than `get`; use it when `get` returns an empty shell."""
    executable = _chrome()
    if not executable:
        raise RuntimeError("No Chrome or Edge installation found; use `get` instead.")
    try:
        # The browser engine has optional dependencies; `get` must not depend on them.
        from scrapling.fetchers import DynamicFetcher
    except ImportError as error:
        raise RuntimeError(f"Browser rendering is not installed ({error}); use `get` instead.") from error
    page = DynamicFetcher.fetch(
        url,
        headless=True,
        executable_path=executable,
        wait_selector=wait_selector,
        network_idle=True,
        timeout=timeout_ms,
    )
    return _content(page, extraction_type, css_selector, main_content_only)


if __name__ == "__main__":
    mcp.run(show_banner=False)
