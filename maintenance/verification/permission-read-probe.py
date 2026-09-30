"""Actual native read-scope proof using only disposable, non-secret fixtures.

The shared transport probe runs real Host/harness binaries. Its HTTP model
stub requests reads; native tool-result messages must contain an unpredictable
fixture token never supplied by the stub. Current Review/Directory are read-only
fallbacks, not workspace isolation. Outside reads are expected to succeed.
"""

import pathlib
import subprocess
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: permission-read-probe.py HOST_BINARY HARNESS_BINARY")
    probe = pathlib.Path(__file__).with_name("read-only-probe.py")
    for profile in ("review", "directory"):
        for read_only in ("false", "true"):
            for outside in (False, True):
                for absolute in (False, True):
                    flags = ["--read-probe"]
                    if outside:
                        flags.append("--outside")
                    if absolute:
                        flags.append("--absolute")
                    subprocess.run(
                        [sys.executable, str(probe), *sys.argv[1:], profile, read_only, *flags],
                        check=True,
                        timeout=140,
                    )
    print("PASS: 16 native read cases; Review/Directory allow inside and outside reads")


if __name__ == "__main__":
    main()
