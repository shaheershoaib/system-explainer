# mini-docs: a tiny fictional team for the source-ingestion layer

Larkspur is a made-up scheduling app for small clinics. Dana (product), Sam (engineering) and
Priya (design) are its team. Every file here is small, ASCII and fictional. The files are what
`system-explainer course fixtures/mini-docs` and the ingest tests read.

| File | Exercises |
| --- | --- |
| `2026-09-02-kickoff-notes.md` | Markdown as is; date from the file name; attendees line becomes speakers. States the original decision: the free tier includes 3 seats. |
| `2026-09-16-pricing-review.vtt` | WebVTT: header, NOTE block, cue numbers and timings dropped; `<v Name>` and `Name:` cues become `[HH:MM:SS] Name: text`. Dana reverses the kickoff decision: the free tier goes to 5 seats from October 1. A course must teach the later decision. |
| `onboarding-guide.html` | HTML to Markdown: title, headings, list items, entities. Its `<script>`, `<style>`, `<noscript>` and an HTML comment holding a prompt-injection attempt must not reach the corpus. |
| `support-faq.txt` | Plain text as is. |
| `roadmap.docx` | Word via unzip/tar: Heading styles, numbered paragraphs, tabs, line breaks, title and modified date from docProps/core.xml. |
| `q4-plan.pptx` | PowerPoint: slides in numeric order, speaker notes found through the slide's relationships (slide 2's notes live in notesSlide1.xml), slide-number fields dropped. |
| `handbook.pdf` | One-page PDF with a text layer, read by pdftotext (a problem with install fixes when pdftotext is missing). |
| `whiteboard.png` | An image: a problem whose first fix is `--transcribe` unless transcription is on. Coursing this folder without `--transcribe` therefore stops loudly by design; pass `--transcribe` or `--allow-partial`. |

This README is itself a Markdown file, so it is ingested with the rest when the folder is coursed.
