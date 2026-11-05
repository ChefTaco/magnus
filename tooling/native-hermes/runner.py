"""Run the unchanged public Hermes source with its bundled, locked dependencies."""
import json
import os
from pathlib import Path
import runpy
import site
import sqlite3
import sys

root = Path(__file__).resolve().parent
site.addsitedir(str(root / "dependencies"))
sys.path.insert(0, str(root / "source"))
if sqlite3.sqlite_version_info < (3, 51, 3):
    raise SystemExit("Bundled SQLite must be 3.51.3 or newer; no state was opened")
if sys.argv[1:] == ["--native-preflight"]:
    import hermes_cli
    import openai
    import httpx
    import yaml
    # Importing the agent initializes profile-dependent allowlists and cron
    # helpers. Preflight runs before the separately journaled profile setup.
    # Compile native entrypoints without executing those initialization hooks;
    # the explicit acceptance command below exercises the actual agent runtime.
    for module in ["hermes_state.py", "run_agent.py", "hermes_cli/main.py"]:
        path = root / "source" / module
        compile(path.read_bytes(), str(path), "exec")
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE VIRTUAL TABLE docs USING fts5(content, tokenize=trigram)")
    provenance = json.loads((root / "provenance.json").read_text(encoding="utf-8"))
    extras = provenance.get("extras", [])
    if extras not in ([], ["messaging"]):
        raise SystemExit("Unreviewed optional native dependency selection")
    if extras == ["messaging"]:
        import aiohttp
        from importlib.metadata import version
        if version("aiohttp") != "3.14.3":
            raise SystemExit("Messaging requires the exact reviewed locked aiohttp version")
    if hermes_cli.__version__ != provenance["version"]:
        raise SystemExit("Public Hermes runtime version does not match provenance")
    print("hermes-agent " + hermes_cli.__version__)
elif sys.argv[1:] in (["--native-acceptance"], ["--native-acceptance", "--expected-answer", "OK"]):
    expected_answer = "OK" if len(sys.argv) == 4 else "READY"
    # A deliberate, harmless turn through the actual public runtime. Tool use,
    # credential enrollment and provider authorization remain separate actions.
    from contextlib import redirect_stdout
    from urllib.parse import urlsplit
    agent = None
    try:
        with redirect_stdout(sys.stderr):
            import hermes_cli
            from hermes_cli.config import load_config
            from hermes_cli.oneshot import _resolve_model_and_provider
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from run_agent import AIAgent
            cfg = load_config()
            choice = _resolve_model_and_provider(cfg, None, None)
            runtime = resolve_runtime_provider(requested=choice.provider, target_model=choice.model or None,
                explicit_base_url=choice.base_url, explicit_api_key=choice.api_key)
            endpoint = urlsplit(runtime.get("base_url") or "")
            if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
                raise ValueError("A verified external HTTPS provider endpoint is required")
            from hermes_cli.config_providers import get_custom_provider_tls_settings
            tls = get_custom_provider_tls_settings(runtime["base_url"], cfg.get("custom_providers"), cfg)
            if tls.get("ssl_verify") is False:
                raise ValueError("Native acceptance requires certificate verification")
            deltas = []
            agent = AIAgent(api_key=runtime.get("api_key"), base_url=runtime.get("base_url"),
                provider=runtime.get("provider"), requested_provider=runtime.get("requested_provider"),
                api_mode=choice.api_mode or runtime.get("api_mode"), model=choice.model,
                enabled_toolsets=[], quiet_mode=True, platform="cli", stream_delta_callback=deltas.append)
            result = agent.run_conversation("Reply with " + expected_answer + ". Do not call tools.")
            if result.get("final_response", "").strip() != expected_answer or not deltas or getattr(agent, "_disable_streaming", False):
                raise ValueError("Native generation and streaming acceptance did not complete")
        print(json.dumps({"ok": True, "product": "hermes-agent", "version": hermes_cli.__version__, "generation": True, "streaming": True, "externalInference": True}))
    except Exception:
        print("Native Hermes acceptance failed; inspect protected diagnostics", file=sys.stderr)
        raise SystemExit(1)
    finally:
        if agent is not None:
            agent.close()
else:
    # No editable install, wheel build, global Python or source mutation.
    runpy.run_module("hermes_cli.main", run_name="__main__")
