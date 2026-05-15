"""Compatibility shim for the Markdown session manager.

The native Markdown editor now lives in the `_editor` builtin plugin. Keep this
module as a narrow import bridge for older extension code that has not yet moved
its import path, but do not add Office-owned Markdown behavior here.
"""

from plugins._editor.helpers.markdown_sessions import MarkdownSession, MarkdownSessionManager, get_manager

__all__ = ["MarkdownSession", "MarkdownSessionManager", "get_manager"]
