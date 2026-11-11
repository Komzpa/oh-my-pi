"""Run offline probes against a COPY. Usage: python3 evidence/seancefork-repro.py KIND MODE PATH OUTPUT_DIR
KIND=fork|registry|observer, MODE=before|after. Never supply a live journal.
"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
kind, mode, source, output = sys.argv[1:]
source = Path(source).resolve()
output = Path(output).resolve()
# Reject the prohibited live locations even when invoked manually.
if source.is_relative_to(Path.home() / ".omp") or output.is_relative_to(Path.home() / ".omp"):
    raise SystemExit("Use a disposable copy outside ~/.omp")
output.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, HOME=str(output / "home"), XDG_CONFIG_HOME=str(output / "home/config"), PI_CODING_AGENT_DIR=str(output / "home/agent"))
baseline = []
probe = root / "evidence" / f"seancefork-{kind}-repro.ts"
try:
    if kind != "observer":
        for relative in ["session/session-manager", "registry/persisted-agents"]:
            target = root / "packages/coding-agent/src" / (relative + ".before.ts")
            if target.exists():
                raise SystemExit(f"Refusing to overwrite {target}")
            content = subprocess.check_output(["git", "show", "66c38306f7d7a69729152ca9b1a2c1c9c9e820f9:packages/coding-agent/src/" + relative + ".ts"], cwd=root)
            target.write_bytes(content)
            baseline.append(target)
        probe.write_text(probe.with_suffix(".ts.in").read_text())
    if kind == "registry":
        (output / "root").mkdir(exist_ok=True)
        subprocess.run(["cp", "--reflink=auto", source, output / "root/RecoverLabelFeedback.jsonl"], check=True)
        args = [str(output)]
    elif kind == "fork":
        args = [str(source), str(output / "fork.jsonl")]
    else:
        child = output / "child.jsonl"
        subprocess.run(["cp", "--reflink=auto", source, child], check=True)
        args = [str(child)]
    with (output / "metrics.json").open("w") as out:
        subprocess.run(["bun", str(probe), mode, *args], cwd=root, env=env, stdout=out, check=True)
finally:
    for target in baseline:
        target.unlink()
    if kind != "observer" and probe.exists():
        probe.unlink()
