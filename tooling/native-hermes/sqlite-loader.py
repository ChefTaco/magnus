"""Load the rebuilt standard SQLite module before the standalone built-in.

The portable interpreter embeds an older SQLite as a built-in module. All normal
bundled Python processes load this owned site customization, including Hermes
subprocesses. The standard SQLite API, WAL checks and corruption guards stay in
force; only the exact rebuilt extension with fixed SQLite is selected.
"""
import importlib.util
import importlib.machinery
from pathlib import Path
import sys

extension = Path(__file__).resolve().parent.parent / "lib-dynload" / (
    "_sqlite3" + importlib.machinery.EXTENSION_SUFFIXES[0]
)
spec = importlib.util.spec_from_file_location("_sqlite3", extension)
if spec is None or spec.loader is None:
    raise RuntimeError("The fixed SQLite standard module is missing")
module = importlib.util.module_from_spec(spec)
sys.modules["_sqlite3"] = module
spec.loader.exec_module(module)
if tuple(int(value) for value in module.sqlite_version.split(".")) < (3, 51, 3):
    raise RuntimeError("The fixed SQLite standard module failed verification")
