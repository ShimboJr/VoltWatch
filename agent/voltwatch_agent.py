"""
voltwatch_agent.py — Convenience entry-point shim.

Allows running the agent directly as:
    python voltwatch_agent.py [options]

instead of the package form:
    python -m voltwatch_agent.main [options]

All CLI arguments are forwarded to voltwatch_agent.main.main().
"""

from voltwatch_agent.main import main

if __name__ == "__main__":
    main()
