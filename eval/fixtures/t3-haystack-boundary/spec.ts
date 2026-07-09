import type { FixtureSpec } from "../../shared/types";

// Haystack fixture: a large, mostly-cosmetic refactor (renames, docstrings,
// extracted helpers) with one behavioral slip buried in the middle: the page
// window becomes end-exclusive-minus-one, dropping the last row of every page.
const spec: FixtureSpec = {
  id: "t3-haystack-boundary",
  kind: "positive",
  tier: 3,
  defectClass: "haystack-off-by-one",
  description:
    "A wide cosmetic refactor of the pagination module hides one real change: page_window now iterates range(start, end - 1), dropping the last row of every page.",
  baseFiles: {
    "lib/pagination.py": `def clamp(n, lo, hi):
    if n < lo:
        return lo
    if n > hi:
        return hi
    return n


def page_count(total, size):
    if size <= 0:
        raise ValueError("size must be positive")
    return (total + size - 1) // size


def page_window(rows, page, size):
    start = page * size
    end = min(start + size, len(rows))
    out = []
    for i in range(start, end):
        out.append(rows[i])
    return out


def render_page(rows, page, size):
    window = page_window(rows, page, size)
    lines = []
    for idx, row in enumerate(window):
        lines.append("%d. %s" % (page * size + idx + 1, row))
    return "\\n".join(lines)


def summarize(rows, size):
    pages = page_count(len(rows), size)
    parts = []
    for p in range(pages):
        parts.append(render_page(rows, p, size))
    return "\\n---\\n".join(parts)
`,
  },
  headFiles: {
    "lib/pagination.py": `def clamp(value, lower, upper):
    """Clamp value into the inclusive [lower, upper] interval."""
    if value < lower:
        return lower
    if value > upper:
        return upper
    return value


def page_count(total_rows, page_size):
    """Number of pages needed for total_rows at page_size rows per page."""
    if page_size <= 0:
        raise ValueError("page_size must be positive")
    return (total_rows + page_size - 1) // page_size


def _window_bounds(page_index, page_size, row_count):
    """Half-open [start, end) bounds of a page within row_count rows."""
    start = page_index * page_size
    end = min(start + page_size, row_count)
    return start, end


def page_window(rows, page_index, page_size):
    """Rows belonging to page_index."""
    start, end = _window_bounds(page_index, page_size, len(rows))
    collected = []
    for position in range(start, end - 1):
        collected.append(rows[position])
    return collected


def _format_row(global_index, row):
    """One display line for a row, 1-based numbering."""
    return "%d. %s" % (global_index + 1, row)


def render_page(rows, page_index, page_size):
    """Render one page of rows as numbered lines."""
    window = page_window(rows, page_index, page_size)
    lines = []
    for offset, row in enumerate(window):
        lines.append(_format_row(page_index * page_size + offset, row))
    return "\\n".join(lines)


def summarize(rows, page_size):
    """Render every page separated by a horizontal rule."""
    total_pages = page_count(len(rows), page_size)
    rendered = []
    for page_index in range(total_pages):
        rendered.append(render_page(rows, page_index, page_size))
    return "\\n---\\n".join(rendered)
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "off.?by.?one|end - 1|last (row|item|element|entry)|dropp|boundar|half.?open|exclusive|missing (row|item)" },
    ],
    anchorFile: "lib/pagination.py",
    anchorLineRange: [24, 31],
  },
};

export default spec;
