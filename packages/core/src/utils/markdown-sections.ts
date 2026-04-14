/**
 * Utilities for parsing markdown into named sections (separated by headings)
 * and manipulating those sections individually.
 */

export interface MarkdownSection {
  /** Heading text (without the `#` prefix) */
  title: string;
  /** The heading line itself including the `#` characters and text */
  heading: string;
  /** Content after the heading up to the next heading of equal or higher level */
  content: string;
  /** Heading level (1 = `#`, 2 = `##`, 3 = `###`) */
  level: number;
  /** Character offset in the full markdown string where this section starts */
  startOffset: number;
  /** Character offset where this section ends (exclusive) */
  endOffset: number;
}

/**
 * Parse a markdown string into a flat list of sections.
 * Only top-level headings (## or ###) are used as section boundaries —
 * h1 headings are treated as section content unless they are the only
 * heading level present.
 *
 * Returns an empty array when no headings are found.
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];

  // Detect the best heading level for top-level section splitting.
  // Strategy: use the SHALLOWEST heading level that has 2+ occurrences,
  // so "# PART 1: ..." sections (H1) take priority over many "##" sub-headings.
  // Falls back to the most common level if no level has 2+ occurrences.
  const headingLevels = lines
    .map((l) => {
      const m = l.match(/^(#{1,3}) /);
      return m ? m[1].length : 0;
    })
    .filter((n) => n > 0);

  if (headingLevels.length === 0) return [];

  const levelCounts = headingLevels.reduce<Record<number, number>>((acc, l) => {
    acc[l] = (acc[l] ?? 0) + 1;
    return acc;
  }, {});

  // Prefer shallowest level (1 > 2 > 3) that appears at least twice
  const levelsWithMultiple = Object.entries(levelCounts)
    .filter(([, count]) => count >= 2)
    .map(([level]) => parseInt(level, 10))
    .sort((a, b) => a - b);

  const dominantLevel = levelsWithMultiple.length > 0
    ? levelsWithMultiple[0]
    : parseInt(
        Object.entries(levelCounts).sort(([, a], [, b]) => b - a)[0][0],
        10,
      );

  let currentSection: {
    title: string;
    heading: string;
    level: number;
    startLine: number;
    contentLines: string[];
    startOffset: number;
  } | null = null;

  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = charOffset;
    charOffset += line.length + 1; // +1 for \n

    const headingMatch = line.match(/^(#{1,3}) (.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      if (level === dominantLevel) {
        // Flush previous section
        if (currentSection) {
          const content = currentSection.contentLines.join('\n').trim();
          sections.push({
            title: currentSection.title,
            heading: currentSection.heading,
            level: currentSection.level,
            content,
            startOffset: currentSection.startOffset,
            endOffset: lineOffset,
          });
        }

        currentSection = {
          title,
          heading: line,
          level,
          startLine: i,
          contentLines: [],
          startOffset: lineOffset,
        };
        continue;
      }
    }

    if (currentSection) {
      currentSection.contentLines.push(line);
    }
  }

  // Flush last section
  if (currentSection) {
    const content = currentSection.contentLines.join('\n').trim();
    sections.push({
      title: currentSection.title,
      heading: currentSection.heading,
      level: currentSection.level,
      content,
      startOffset: currentSection.startOffset,
      endOffset: charOffset,
    });
  }

  return sections;
}

/**
 * Replace the content of a specific section in the full markdown string
 * with `newContent`, leaving the heading intact.
 */
export function replaceSectionContent(
  markdown: string,
  section: MarkdownSection,
  newContent: string,
): string {
  const before = markdown.slice(0, section.startOffset);
  const after = markdown.slice(section.endOffset);
  const updated = `${section.heading}\n\n${newContent.trim()}\n\n`;
  return `${before}${updated}${after}`;
}

/**
 * Returns the text that appears before the first section heading.
 */
export function getPreSectionText(markdown: string, sections: MarkdownSection[]): string {
  if (sections.length === 0) return markdown;
  return markdown.slice(0, sections[0].startOffset);
}

/**
 * Returns the text that appears after the last section ends.
 */
export function getPostSectionText(markdown: string, sections: MarkdownSection[]): string {
  if (sections.length === 0) return '';
  const last = sections[sections.length - 1];
  return markdown.slice(last.endOffset);
}
