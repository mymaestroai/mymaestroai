#!/usr/bin/env python3
"""Render a page in a real browser and print its HTML (used by lib/web-fetch.js for JavaScript-only pages).

Usage: python -I web-render.py <url>
Needs Playwright with Firefox installed in the interpreter that runs it (pip install playwright; playwright install firefox).
Firefox, not Chromium: headless Chromium hangs on some Linux boxes (GPU/compositor); Firefox does not.
"""
import sys

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: web-render.py <url>\n")
        return 2
    url = sys.argv[1]
    if not url.lower().startswith(("http://", "https://")):
        sys.stderr.write("only http(s) URLs\n")
        return 2
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout  # noqa: E402

    with sync_playwright() as p:
        browser = p.firefox.launch()
        try:
            page = browser.new_page(user_agent=UA, viewport={"width": 1280, "height": 900})
            try:
                page.goto(url, wait_until="networkidle", timeout=25000)
            except PWTimeout:
                # Pages with long-polling never go idle; whatever has loaded by now is what we return.
                pass
            page.wait_for_timeout(500)
            sys.stdout.write(page.content())
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
