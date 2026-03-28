/**
 * VLM Document Parser — vision model integration for ingesting legacy documents.
 *
 * Legacy modernization projects often include:
 *   - Architecture diagrams (Visio, PowerPoint, PNG/PDF exports)
 *   - Database ERD diagrams
 *   - Network topology diagrams
 *   - Scanned specification documents
 *   - Whiteboard photos of system flows
 *   - Screenshots of legacy application UIs
 *
 * This service uses vision-capable LLMs (GPT-4o, Claude 3.5, Gemini Pro Vision)
 * to extract structured information from these visual artifacts, making them
 * available as context for pipeline stages.
 *
 * Inspired by OpenViking's VLM parsing pattern for legacy document ingestion.
 */

import { llmProxyService } from "./llm-proxy.js";

// ─── TYPES ──────────────────────────────────────────────────────

export type DocumentType =
  | "architecture_diagram"
  | "erd_diagram"
  | "network_diagram"
  | "ui_screenshot"
  | "specification_doc"
  | "whiteboard_photo"
  | "flowchart"
  | "data_flow_diagram"
  | "unknown";

export interface ParsedDocument {
  /** Original file name */
  fileName: string;
  /** Detected document type */
  documentType: DocumentType;
  /** Structured extraction result */
  extraction: DocumentExtraction;
  /** Raw text description from VLM */
  rawDescription: string;
  /** Confidence in the extraction (0-1) */
  confidence: number;
  /** Processing metadata */
  meta: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    processingMs: number;
  };
}

export interface DocumentExtraction {
  /** High-level summary of what the document shows */
  summary: string;
  /** Components/entities identified in the document */
  components: ExtractedComponent[];
  /** Relationships/connections between components */
  relationships: ExtractedRelationship[];
  /** Text content extracted from the document */
  textContent: string[];
  /** Technologies/tools mentioned or depicted */
  technologies: string[];
  /** Key observations relevant to modernization */
  modernizationNotes: string[];
}

export interface ExtractedComponent {
  name: string;
  type: string;
  description?: string;
  properties?: Record<string, string>;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  label?: string;
}

// ─── DOCUMENT TYPE DETECTION ────────────────────────────────────

const DOCUMENT_TYPE_HINTS: Record<string, DocumentType[]> = {
  // File name patterns
  "arch": ["architecture_diagram"],
  "architecture": ["architecture_diagram"],
  "erd": ["erd_diagram"],
  "entity": ["erd_diagram"],
  "network": ["network_diagram"],
  "topology": ["network_diagram"],
  "infra": ["network_diagram"],
  "screen": ["ui_screenshot"],
  "ui": ["ui_screenshot"],
  "mockup": ["ui_screenshot"],
  "spec": ["specification_doc"],
  "requirement": ["specification_doc"],
  "whiteboard": ["whiteboard_photo"],
  "flow": ["flowchart", "data_flow_diagram"],
  "dfd": ["data_flow_diagram"],
  "dataflow": ["data_flow_diagram"],
};

function guessDocumentType(fileName: string): DocumentType {
  const lower = fileName.toLowerCase();
  for (const [hint, types] of Object.entries(DOCUMENT_TYPE_HINTS)) {
    if (lower.includes(hint)) return types[0];
  }
  return "unknown";
}

// ─── PROMPT TEMPLATES ───────────────────────────────────────────

function getExtractionPrompt(docType: DocumentType): string {
  const baseInstruction = `You are analyzing a document image from a legacy application modernization project.
Extract structured information that will help the modernization team understand the existing system.

Respond in valid JSON with this structure:
{
  "summary": "one-paragraph summary of what this document shows",
  "documentType": "detected type (architecture_diagram, erd_diagram, network_diagram, ui_screenshot, specification_doc, whiteboard_photo, flowchart, data_flow_diagram)",
  "components": [
    { "name": "component name", "type": "service|database|ui|api|queue|storage|external", "description": "brief description", "properties": {} }
  ],
  "relationships": [
    { "source": "component A", "target": "component B", "type": "calls|reads|writes|depends_on|connects_to", "label": "optional label" }
  ],
  "textContent": ["any text strings visible in the document"],
  "technologies": ["technology names detected or implied"],
  "modernizationNotes": ["observations relevant to modernization planning"],
  "confidence": 0.85
}`;

  const typeSpecific: Record<DocumentType, string> = {
    architecture_diagram:
      "This appears to be an architecture diagram. Pay special attention to: " +
      "service boundaries, data stores, communication patterns (sync/async), " +
      "external integrations, and deployment topology.",
    erd_diagram:
      "This appears to be an Entity-Relationship Diagram. Pay special attention to: " +
      "entity names and attributes, relationship cardinalities (1:1, 1:N, M:N), " +
      "primary/foreign keys, and inheritance hierarchies.",
    network_diagram:
      "This appears to be a network/infrastructure diagram. Pay special attention to: " +
      "servers, load balancers, firewalls, network segments, " +
      "IP ranges or subnet information, and external connectivity.",
    ui_screenshot:
      "This appears to be a UI screenshot of the legacy application. Pay special attention to: " +
      "form fields and their types, navigation structure, data displayed, " +
      "user workflow implied by the screen, and any status/error messages.",
    specification_doc:
      "This appears to be a specification or requirements document. Pay special attention to: " +
      "business rules, constraints, data definitions, workflow descriptions, " +
      "acceptance criteria, and cross-references to other documents.",
    whiteboard_photo:
      "This appears to be a whiteboard photo. Pay special attention to: " +
      "hand-drawn diagrams, annotations, decision notes, " +
      "action items, and any system architecture sketches.",
    flowchart:
      "This appears to be a flowchart. Pay special attention to: " +
      "process steps, decision points, parallel paths, " +
      "start/end conditions, and exception handling paths.",
    data_flow_diagram:
      "This appears to be a data flow diagram. Pay special attention to: " +
      "data sources, transformations, data stores, " +
      "external entities, and data flow directions/volumes.",
    unknown:
      "Analyze this document and determine what type of technical artifact it represents. " +
      "Extract any information relevant to understanding a legacy system.",
  };

  return `${baseInstruction}\n\n${typeSpecific[docType] || typeSpecific.unknown}`;
}

// ─── CORE PARSING ───────────────────────────────────────────────

/**
 * Parse a document image using a vision-capable LLM.
 *
 * @param imageBase64 - Base64-encoded image data
 * @param fileName - Original filename (used for type hints)
 * @param mimeType - Image MIME type (image/png, image/jpeg, image/webp, application/pdf)
 * @param options - Additional parsing options
 */
export async function parseDocumentImage(
  imageBase64: string,
  fileName: string,
  mimeType: string = "image/png",
  options?: {
    /** Force a specific document type instead of auto-detecting */
    documentType?: DocumentType;
    /** Additional context to include in the prompt */
    additionalContext?: string;
    /** Model to use (defaults to vision-capable model) */
    model?: string;
  },
): Promise<ParsedDocument> {
  const startTime = Date.now();
  const docType = options?.documentType || guessDocumentType(fileName);
  const prompt = getExtractionPrompt(docType);

  const fullPrompt = options?.additionalContext
    ? `${prompt}\n\nAdditional context about this project:\n${options.additionalContext}`
    : prompt;

  // Use the LLM proxy with vision capabilities
  const model = options?.model || process.env.LLM_VISION_MODEL || "gpt-4o";
  const callFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model,
  });

  // Embed image reference in prompt since the LLM proxy may not support
  // separate image parameters. The vision model will receive the base64
  // data as part of the prompt content.
  const visionPrompt = `${fullPrompt}\n\n[Image: ${fileName} (${mimeType}, ${Math.round(imageBase64.length / 1024)}KB base64)]`;

  const rawText = await callFn({
    systemPrompt: "You are a document analysis expert for legacy application modernization.",
    userPrompt: visionPrompt,
  });

  const processingMs = Date.now() - startTime;

  // Parse the JSON response
  let extraction: DocumentExtraction;
  let detectedType = docType;
  let confidence = 0.5;

  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawText];
    const parsed = JSON.parse(jsonMatch[1]!.trim());

    extraction = {
      summary: parsed.summary || "No summary extracted",
      components: Array.isArray(parsed.components) ? parsed.components : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      textContent: Array.isArray(parsed.textContent) ? parsed.textContent : [],
      technologies: Array.isArray(parsed.technologies) ? parsed.technologies : [],
      modernizationNotes: Array.isArray(parsed.modernizationNotes) ? parsed.modernizationNotes : [],
    };

    if (parsed.documentType) {
      detectedType = parsed.documentType as DocumentType;
    }
    confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.7;
  } catch {
    // Fallback: treat entire response as raw description
    extraction = {
      summary: rawText.slice(0, 500),
      components: [],
      relationships: [],
      textContent: [rawText],
      technologies: [],
      modernizationNotes: [],
    };
    confidence = 0.3;
  }

  return {
    fileName,
    documentType: detectedType,
    extraction,
    rawDescription: rawText,
    confidence,
    meta: {
      model,
      inputTokens: Math.ceil(visionPrompt.length / 4),
      outputTokens: Math.ceil(rawText.length / 4),
      processingMs,
    },
  };
}

/**
 * Parse multiple document images in sequence (to avoid memory pressure).
 * Returns results in the same order as inputs.
 */
export async function parseDocumentBatch(
  documents: Array<{
    imageBase64: string;
    fileName: string;
    mimeType?: string;
  }>,
  options?: {
    additionalContext?: string;
    model?: string;
    /** Maximum documents to process (default: 10) */
    maxDocuments?: number;
  },
): Promise<ParsedDocument[]> {
  const max = options?.maxDocuments ?? 10;
  const toProcess = documents.slice(0, max);
  const results: ParsedDocument[] = [];

  for (const doc of toProcess) {
    try {
      const result = await parseDocumentImage(
        doc.imageBase64,
        doc.fileName,
        doc.mimeType || "image/png",
        { additionalContext: options?.additionalContext, model: options?.model },
      );
      results.push(result);
    } catch (err) {
      // Include a failed entry so the caller knows which document errored
      results.push({
        fileName: doc.fileName,
        documentType: "unknown",
        extraction: {
          summary: `Failed to parse: ${err instanceof Error ? err.message : String(err)}`,
          components: [],
          relationships: [],
          textContent: [],
          technologies: [],
          modernizationNotes: [],
        },
        rawDescription: "",
        confidence: 0,
        meta: { model: options?.model || "unknown", inputTokens: 0, outputTokens: 0, processingMs: 0 },
      });
    }
  }

  return results;
}

/**
 * Convert parsed documents into a text context block suitable for
 * injection into pipeline stage prompts.
 */
export function parsedDocumentsToContext(docs: ParsedDocument[]): string {
  if (docs.length === 0) return "";

  const sections: string[] = [
    "## Visual Document Analysis",
    `${docs.length} document(s) analyzed via vision model.\n`,
  ];

  for (const doc of docs) {
    if (doc.confidence < 0.2) continue; // Skip very low confidence

    sections.push(`### ${doc.fileName} (${doc.documentType})`);
    sections.push(doc.extraction.summary);

    if (doc.extraction.components.length > 0) {
      sections.push("\n**Components:**");
      for (const comp of doc.extraction.components) {
        sections.push(`- **${comp.name}** (${comp.type}): ${comp.description || "no description"}`);
      }
    }

    if (doc.extraction.relationships.length > 0) {
      sections.push("\n**Relationships:**");
      for (const rel of doc.extraction.relationships) {
        sections.push(`- ${rel.source} → ${rel.target} (${rel.type}${rel.label ? `: ${rel.label}` : ""})`);
      }
    }

    if (doc.extraction.technologies.length > 0) {
      sections.push(`\n**Technologies:** ${doc.extraction.technologies.join(", ")}`);
    }

    if (doc.extraction.modernizationNotes.length > 0) {
      sections.push("\n**Modernization Notes:**");
      for (const note of doc.extraction.modernizationNotes) {
        sections.push(`- ${note}`);
      }
    }

    sections.push(""); // Blank line separator
  }

  return sections.join("\n");
}
