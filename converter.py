#!/usr/bin/env python3

"""
Convert the Friday Online Students_Timetable_Report PDF to NDJSON.

Usage from Node.js:
    python3 convert.py /path/to/uploaded.pdf

Output:
    students_timetable.ndjson

The PDF path is supplied as the first command-line argument.
The output filename is intentionally fixed because Node.js monitors it.

Requires:
    pip install pdfplumber
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TIME_SLOTS: List[str] = [
    "08:00-09:20",
    "09:30-10:50",
    "11:00-12:20",
    "12:30-01:50",
    "02:05-03:25",
    "03:30-04:50",
    "05:00-05:30",
]

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]

EXPECTED_COLS = 1 + len(TIME_SLOTS)  # 8

# Node.js monitors this exact file.
# Put it beside converter.py regardless of the process's working directory.
OUTPUT_FILE = Path(__file__).resolve().parent / "students_timetable.ndjson"



# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

# Lab courses have "L" as the second character:
# CL3001, SL3001, etc.
LAB_CODE_RE = re.compile(r"^[A-Z]L\d")

HEADER_LINE_RE = re.compile(
    r"^\s*"
    r"(?P<code>[A-Z]{2,5}\d{3,4})"
    r"\s*,\s*"
    r"(?P<section>[A-Za-z0-9\-]+)"
    r"\s*:\s*"
    r"(?P<subject>.*)"
    r"$"
)

# Venue/room appears in trailing parentheses.
ROOM_RE = re.compile(
    r"\(\s*(?P<room>[^)]*?)\s*\)\s*$"
)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def is_lab_course(course_code: Optional[str]) -> bool:
    return bool(course_code) and bool(LAB_CODE_RE.match(course_code))


def slot_range_label(start_slot: str, end_slot: str) -> str:
    """Combine two time slots into one spanning range."""
    start = start_slot.split("-")[0]
    end = end_slot.split("-")[1]
    return f"{start}-{end}"


def clean_text(text: str) -> str:
    """Collapse whitespace while preserving useful text."""
    return re.sub(r"\s+", " ", text.strip())


def normalize_cell_lines(cell: Any) -> List[str]:
    """
    Return a cell's content as cleaned, non-empty lines.

    The line breaks are important because the PDF normally separates:
      course/subject
      teacher
      room
    into different lines.
    """
    if cell is None:
        return []

    raw = str(cell)

    lines = [clean_text(line) for line in raw.split("\n")]

    lines = [
        line
        for line in lines
        if line and line.lower() not in {"none", "null", "nan"}
    ]

    return lines


def normalize_cell(cell: Any) -> Optional[str]:
    """Flatten a cell into one line for header/day validation."""
    lines = normalize_cell_lines(cell)

    if not lines:
        return None

    return " ".join(lines)


# ---------------------------------------------------------------------------
# Cell parsing
# ---------------------------------------------------------------------------

def parse_class_cell(
    lines: List[str],
) -> Tuple[Dict[str, Optional[str]], List[str]]:
    """
    Parse one occupied timetable cell.

    Returns:
        (
            {
                "course_code": ...,
                "section": ...,
                "subject": ...,
                "teacher": ...,
                "room": ...
            },
            warnings
        )

    Nothing is discarded silently. Parsing problems become warnings.
    """

    warnings: List[str] = []

    raw = " ".join(lines)

    record: Dict[str, Optional[str]] = {
        "course_code": None,
        "section": None,
        "subject": None,
        "teacher": None,
        "room": None,
    }

    if not lines:
        return record, warnings

    # ---------------------------------------------------------------
    # Find room/venue
    # ---------------------------------------------------------------

    body_lines = list(lines)
    room_found = False

    # Start at the bottom and accumulate upward because the room can
    # sometimes wrap:
    #
    #   Some Teacher (Room
    #   11)
    #
    accum = ""

    for idx in range(len(lines) - 1, -1, -1):
        if accum:
            accum = f"{lines[idx]} {accum}"
        else:
            accum = lines[idx]

        match = ROOM_RE.search(accum)

        if match:
            record["room"] = match.group("room").strip()

            leftover = accum[:match.start()].strip()

            body_lines = lines[:idx]

            if leftover:
                body_lines.append(leftover)

            room_found = True
            break

    if not room_found:
        warnings.append(
            f"no room found in cell: '{raw}'"
        )

    if not body_lines:
        warnings.append(
            f"cell empty after removing room: '{raw}'"
        )
        return record, warnings

    # ---------------------------------------------------------------
    # Parse course / section / subject
    # ---------------------------------------------------------------

    header_match = HEADER_LINE_RE.match(body_lines[0])

    if header_match:
        record["course_code"] = header_match.group("code")
        record["section"] = header_match.group("section")

        subject_part = header_match.group("subject").strip()

        rest_lines = body_lines[1:]

    else:
        warnings.append(
            "could not parse course/section header from: "
            f"'{body_lines[0]}'"
        )

        subject_part = ""
        rest_lines = body_lines

    # ---------------------------------------------------------------
    # Parse teacher
    # ---------------------------------------------------------------
    #
    # In the source PDF, the teacher is the final line before the room.
    #
    # IMPORTANT:
    # The old version referenced `room_line_idx`, which didn't exist.
    # This version simply uses the remaining lines safely.
    # ---------------------------------------------------------------

    if rest_lines:
        teacher_line = rest_lines[-1].strip()

        record["teacher"] = (
            teacher_line if teacher_line else None
        )

        extra_subject_lines = rest_lines[:-1]

    else:
        extra_subject_lines = []

        warnings.append(
            f"no teacher line found in cell: '{raw}'"
        )

    # ---------------------------------------------------------------
    # Build subject
    # ---------------------------------------------------------------

    subject_parts = []

    if subject_part:
        subject_parts.append(subject_part)

    subject_parts.extend(
        line
        for line in extra_subject_lines
        if line
    )

    subject_full = " ".join(subject_parts).strip()

    record["subject"] = (
        subject_full if subject_full else None
    )

    if not subject_full:
        warnings.append(
            f"no subject text found in cell: '{raw}'"
        )

    return record, warnings


# ---------------------------------------------------------------------------
# Table extraction
# ---------------------------------------------------------------------------

def extract_schedule_from_table(
    table: List[List[Any]],
) -> Tuple[Dict[str, List[Dict[str, Any]]], List[str]]:
    """
    Map a PDF table into:

    {
        "Mon": [
            {
                "time_slot": "08:00-09:20",
                "course_code": "...",
                "section": "...",
                "subject": "...",
                "teacher": "...",
                "room": "..."
            }
        ],
        ...
    }

    Uses fixed column indexes instead of text order.
    """

    warnings: List[str] = []

    schedule: Dict[str, List[Dict[str, Any]]] = {
        day: []
        for day in DAYS
    }

    if not table:
        warnings.append("empty table")
        return schedule, warnings

    # ---------------------------------------------------------------
    # Header validation
    # ---------------------------------------------------------------

    header = table[0]

    if len(header) < EXPECTED_COLS:
        warnings.append(
            f"header has {len(header)} cols "
            f"(expected {EXPECTED_COLS})"
        )

    else:
        for i, expected in enumerate(TIME_SLOTS, start=1):
            actual = normalize_cell(header[i]) or ""

            exp_clean = (
                expected
                .replace("\u2013", "-")
                .replace("\u2014", "-")
                .lstrip("0")
            )

            act_clean = (
                actual
                .replace("\u2013", "-")
                .replace("\u2014", "-")
                .lstrip("0")
            )

            if (
                actual
                and exp_clean not in act_clean
                and act_clean not in exp_clean
            ):
                warnings.append(
                    f"header col {i}: expected "
                    f"'{expected}' got '{actual}'"
                )

    # ---------------------------------------------------------------
    # Day rows
    # ---------------------------------------------------------------

    for row_idx, day in enumerate(DAYS, start=1):

        if row_idx >= len(table):
            warnings.append(
                f"missing row for {day}"
            )
            break

        row = table[row_idx]

        day_label = (
            normalize_cell(row[0])
            if row
            else None
        )

        if day_label and day not in day_label:
            warnings.append(
                f"row {row_idx} day label "
                f"'{day_label}' does not contain '{day}'"
            )

        # -----------------------------------------------------------
        # Time-slot columns
        # -----------------------------------------------------------

        for col_idx, slot in enumerate(
            TIME_SLOTS,
            start=1
        ):

            if col_idx >= len(row):
                break

            lines = normalize_cell_lines(
                row[col_idx]
            )

            # Empty cell = no class.
            if not lines:
                continue

            class_record, cell_warnings = (
                parse_class_cell(lines)
            )

            # -------------------------------------------------------
            # Lab courses span two slots.
            # -------------------------------------------------------

            time_slot_label = slot

            if is_lab_course(
                class_record["course_code"]
            ):

                next_idx = col_idx + 1

                if (
                    next_idx < len(TIME_SLOTS) + 1
                    and next_idx < len(row)
                    and row[next_idx] is None
                ):
                    time_slot_label = (
                        slot_range_label(
                            slot,
                            TIME_SLOTS[next_idx - 1],
                        )
                    )

                else:
                    warnings.append(
                        f"{day} {slot}: lab course "
                        f"'{class_record['course_code']}' "
                        "expected a merged next slot "
                        "but none was found"
                    )

            # -------------------------------------------------------
            # Add time slot first for clean JSON output.
            # -------------------------------------------------------

            class_record = {
                "time_slot": time_slot_label,
                **class_record,
            }

            schedule[day].append(
                class_record
            )

            for warning in cell_warnings:
                warnings.append(
                    f"{day} {slot}: {warning}"
                )

    return schedule, warnings


# ---------------------------------------------------------------------------
# Page processing
# ---------------------------------------------------------------------------

def process_page(
    page: Any,
    page_number: int,
) -> List[Dict[str, Any]]:
    """
    Process one PDF page.

    Each page may contain multiple student timetables.
    """

    text = page.extract_text() or ""

    student_ids = re.findall(
        r"Timetable for\s+([A-Z0-9P\-]+)",
        text,
    )

    tables = page.extract_tables() or []

    records: List[Dict[str, Any]] = []

    pair_count = min(
        len(student_ids),
        len(tables),
    )

    if len(student_ids) != len(tables):
        print(
            f"WARNING page {page_number}: "
            f"{len(student_ids)} IDs vs "
            f"{len(tables)} tables - "
            f"pairing first {pair_count}",
            file=sys.stderr,
        )

    for i in range(pair_count):

        schedule, warnings = (
            extract_schedule_from_table(
                tables[i]
            )
        )

        record: Dict[str, Any] = {
            "student_id": student_ids[i],
            "page": page_number,
            "class_count": sum(
                len(day_classes)
                for day_classes in schedule.values()
            ),
            "schedule": schedule,
        }

        if warnings:
            record["_warnings"] = warnings

        records.append(record)

    return records


# ---------------------------------------------------------------------------
# Main PDF conversion
# ---------------------------------------------------------------------------

def process_pdf(pdf_path: Path) -> None:
    """
    Read PDF and overwrite students_timetable.ndjson.

    The output is written atomically:
        temporary file -> students_timetable.ndjson

    This prevents Node.js from reading a half-written file.
    """

    if not pdf_path.exists():
        raise FileNotFoundError(
            f"PDF not found: {pdf_path}"
        )

    if not pdf_path.is_file():
        raise ValueError(
            f"PDF path is not a file: {pdf_path}"
        )

    print(f"PDF    : {pdf_path.resolve()}")
    print(f"Output : {OUTPUT_FILE.resolve()}")
    print(
        "Processing page-by-page (NDJSON) ..."
    )

    total_students = 0
    total_warnings = 0

    # Create temporary output in the same directory.
    # os.replace() is then atomic on the same filesystem.
    output_dir = OUTPUT_FILE.parent.resolve()

    temp_path: Optional[Path] = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=output_dir,
            prefix=".students_timetable_",
            suffix=".tmp",
            delete=False,
        ) as temp_file:

            temp_path = Path(temp_file.name)

            with pdfplumber.open(
                str(pdf_path)
            ) as pdf:

                # Skip final analytics page.
                pages_to_do = max(
                    0,
                    len(pdf.pages) - 1,
                )

                for page_idx in range(
                    pages_to_do
                ):

                    page_number = page_idx + 1

                    records = process_page(
                        pdf.pages[page_idx],
                        page_number,
                    )

                    for record in records:

                        if "_warnings" in record:
                            total_warnings += len(
                                record["_warnings"]
                            )

                        temp_file.write(
                            json.dumps(
                                record,
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

                        total_students += 1

                    # Flush periodically.
                    if (
                        page_number % 30 == 0
                        or page_number == pages_to_do
                    ):
                        temp_file.flush()

                        print(
                            f"  page "
                            f"{page_number}/"
                            f"{pages_to_do} "
                            f"-> {total_students} "
                            f"students",
                            flush=True,
                        )

        # Atomically replace the old NDJSON.
        os.replace(
            str(temp_path),
            str(OUTPUT_FILE),
        )

        temp_path = None

    finally:
        # Clean up temporary file if something failed.
        if (
            temp_path is not None
            and temp_path.exists()
        ):
            try:
                temp_path.unlink()
            except OSError:
                pass

    print()
    print(
        f"Finished. Students: "
        f"{total_students}  "
        f"Soft warnings: "
        f"{total_warnings}"
    )

    print(
        f"Output: "
        f"{OUTPUT_FILE.resolve()}"
    )

    print(
        "Each line is a complete JSON object (NDJSON)."
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> int:

    # Node.js calls:
    #
    #   python3 convert.py /path/to/uploaded.pdf
    #
    if len(sys.argv) < 2:
        print(
            "ERROR: PDF path was not provided.",
            file=sys.stderr,
        )

        print(
            "Usage: python3 convert.py <pdf_path>",
            file=sys.stderr,
        )

        return 1

    pdf_path = Path(sys.argv[1])

    try:
        process_pdf(pdf_path)

    except Exception as exc:
        print(
            f"ERROR: PDF conversion failed: {exc}",
            file=sys.stderr,
        )

        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())