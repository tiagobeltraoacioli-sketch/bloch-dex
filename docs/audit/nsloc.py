#!/usr/bin/env python3
"""Count SLOC and nSLOC of Solidity files for the audit package.

SLOC:  lines that hold code after removing comments (// and /* */, NatSpec
       included) and blank lines.
nSLOC: SLOC with each multi-line construct counted once: lines are joined
       while a ( or [ is still open, so a function header or call that
       forge fmt wraps over several lines counts as one line.

String literals are respected, so "//" inside a string is not a comment.
Usage: python3 -I docs/audit/nsloc.py <file.sol>...
"""
import sys


def strip_comments(src):
    out, i, n = [], 0, len(src)
    in_str = None
    while i < n:
        c = src[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
        elif c in "\"'":
            in_str = c
            out.append(c)
            i += 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            seg = src[i : (n if j < 0 else j + 2)]
            out.append("\n" * seg.count("\n"))
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def count(path):
    code = strip_comments(open(path, encoding="utf-8").read())
    lines = [l.strip() for l in code.splitlines() if l.strip()]
    sloc = len(lines)
    nsloc, depth = 0, 0
    for l in lines:
        if depth == 0:
            nsloc += 1
        for ch in l:
            if ch in "([":
                depth += 1
            elif ch in ")]":
                depth = max(0, depth - 1)
    return sloc, nsloc


if __name__ == "__main__":
    total_s = total_n = 0
    for p in sys.argv[1:]:
        s, n = count(p)
        total_s += s
        total_n += n
        print(f"{p}\t{s}\t{n}")
    print(f"TOTAL\t{total_s}\t{total_n}")
