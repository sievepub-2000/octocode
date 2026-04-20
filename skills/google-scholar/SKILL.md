---
name: google-scholar
description: Academic research skill for finding, summarizing, and citing scholarly papers using Google Scholar and related academic databases.
---

# google-scholar

Search and summarize academic literature for research tasks.

## When to use

- The user needs academic papers, citations, or literature reviews.
- A technical decision should be backed by published research.
- State-of-the-art survey for a specific topic is needed.

## Instructions

1. **Formulate query**: Convert the user's question into 2–3 academic search queries using domain-specific keywords.
2. **Search execution**: Use the `web-browse` tool to query `https://scholar.google.com/scholar?q=<encoded_query>` and extract results.
3. **Result parsing**: For each paper found, extract:
   - Title, authors, year
   - Publication venue (journal/conference)
   - Citation count (as relevance signal)
   - Abstract or snippet
4. **Relevance filtering**: Rank papers by: citation count × recency × query relevance. Present top 5–10.
5. **Summarization**: For each selected paper, provide:
   - One-line finding
   - Key methodology
   - Main results/conclusions
   - Limitations noted
6. **Literature review format**: When requested, organize findings into:
   - Background/motivation
   - Approaches categorized by method type
   - Comparative table of methods vs metrics
   - Open questions and future directions
7. **Citations**: Use standard academic citation format (Author, Year. Title. Venue.).
8. Note: Google Scholar has no official API. Rate-limit requests and respect `robots.txt`. Consider SerpAPI for reliable programmatic access.
