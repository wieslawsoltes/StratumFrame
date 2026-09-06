"""Verify deployed module and standalone builds, including real worker calculations.

Requires the optional CI dependency playwright==1.57.0. No app dependencies.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--expected-sha", default="")
    parser.add_argument("--output", type=Path, default=Path("verification/live"))
    args = parser.parse_args()
    base = args.url.rstrip("/") + "/"
    if urlparse(base).scheme not in ("https", "http"):
        parser.error("--url must be an HTTP(S) site")
    args.output.mkdir(parents=True, exist_ok=True)

    # Pages propagation may briefly expose the previous deployment. Never accept it.
    metadata = None
    last_error = "No build metadata received"
    for attempt in range(18):
        try:
            request = Request(urljoin(base, "build-info.json") + f"?probe={time.time_ns()}",
                              headers={"Cache-Control": "no-cache"})
            with urlopen(request, timeout=15) as response:
                metadata = json.load(response)
            if args.expected_sha and metadata.get("commit") != args.expected_sha:
                raise ValueError(f"Expected commit {args.expected_sha}, received {metadata.get('commit')}")
            break
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            last_error = str(error)
            if attempt == 17:
                raise RuntimeError(f"Deployment did not become available: {last_error}") from error
            time.sleep(5)

    report = {"timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
              "deployment": metadata, "pages": [], "passed": False}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            report["browser"] = browser.version
            for name, relative in (("modules", ""), ("standalone", "stratum-frame.html")):
                context = browser.new_context(viewport={"width": 1600, "height": 1000})
                page = context.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: errors.append(message.text)
                        if message.type == "error" else None)
                url = urljoin(base, relative)
                response = page.goto(url, wait_until="load", timeout=45000)
                assert response is not None and response.status == 200, f"HTTP failure: {url}"
                page.wait_for_function("window.stratum && !stratum.running && stratum.state.results",
                                       timeout=60000)
                result = page.evaluate("""() => ({
                    backend: stratum.main.backend,
                    stats: stratum.state.results.stats,
                    frequencies: stratum.state.results.modes.map(mode => mode.frequency),
                    joints: stratum.model.nodes.length,
                    members: stratum.model.elements.length
                })""")
                assert result["joints"] == 84 and result["members"] == 174, result
                assert result["stats"]["activeDOFs"] == 234, result
                assert len(result["frequencies"]) == 6, result
                assert all(math.isfinite(f) and f > 0 for f in result["frequencies"]), result
                assert abs(result["frequencies"][0] - 1.73661595763811) < 1e-9, result
                for display in ("deformed", "mode", "reactions"):
                    page.locator("#display-select").select_option(display)
                    page.wait_for_timeout(100)
                    assert page.evaluate("stratum.state.display") == display
                page.locator("#display-select").select_option("model")
                page.screenshot(path=str(args.output / f"{name}.png"), full_page=True)
                page.evaluate('stratum.action("benchmarks")')
                page.wait_for_function('document.querySelector("#dialog-content").textContent.includes("32 / 32")',
                                       timeout=30000)
                assert not errors, errors
                record = {"name": name, "url": url, "httpStatus": response.status,
                          **result, "analyticalBenchmarks": 32, "errors": errors, "passed": True}
                report["pages"].append(record)
                print(json.dumps(record, indent=2), flush=True)
                context.close()
            browser.close()
        report["passed"] = True
    finally:
        (args.output / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("PASS: Both deployed entry points run the worker and all 32 analytical benchmarks.")


if __name__ == "__main__":
    main()
